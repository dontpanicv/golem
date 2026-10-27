//! `golem-hands supervise`: the long-lived process that owns supervised jobs (jobs.rs), so they outlive `serve` and the
//! phone's connection. `serve` reaches it over the Unix socket `supervisor.sock` in the user-only state dir
//! (state.rs), one request per connection, in the frames of docs/protocol.md: a request frame `{ op, ... }`,
//! answered by one result or error frame. Its operations ([`SupervisorOp`]) are its own: `serve` forwards `job.*` and `cua.*`
//! here, and the CLI asks for `hello` (the supervisor's own, not `serve`'s), `access` and `shutdown`.
//!
//! One supervisor runs per state dir: it holds `supervisor.lock`. Started by launchd or systemd (`golem-hands install`),
//! it waits for the lock, taking over when an earlier supervisor exits. Started on demand by `serve` (`--detached`),
//! it exits at once if another supervisor holds the lock.
//!
//! Started by launchd, it also runs Cua Driver for `cua.*` (cua.rs); the driver's agent cursor then takes the main
//! thread, and connections are accepted on another.

use crate::errors::Failure;
use crate::frame::{self, ERROR, Frame, REQUEST, RESULT};
use crate::jobs::Jobs;
use crate::serve::{PROTOCOL, VERSION};
use crate::{cua, state};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const PRUNE_INTERVAL: Duration = Duration::from_secs(3600);
/// How long `serve` waits for a supervisor it started to listen.
const START_TIMEOUT: Duration = Duration::from_secs(5);

/// The pids of the `golem-hands __serve` children of this process's listener (listener.rs). In service mode only they
/// may ask for `job.*` and `cua.*`: the service holds the permissions macOS gave hands, and another program of the same
/// user must not use them through this socket.
pub static SERVE_PIDS: Mutex<BTreeSet<u32>> = Mutex::new(BTreeSet::new());

pub fn run(detached: bool) -> io::Result<()> {
    let dir = state::ensure()?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("supervisor.lock"))?;
    if !state::lock(&lock, !detached)? {
        return Ok(());
    }
    let socket = state::socket();
    // Holding the lock, any socket file is a dead supervisor's.
    let _ = fs::remove_file(&socket);
    // SAFETY: umask before any thread starts; the socket is created user-only, then the mask is restored for jobs.
    let previous = unsafe { libc::umask(0o077) };
    let listener = UnixListener::bind(&socket);
    unsafe { libc::umask(previous) };
    let listener = listener?;
    let jobs = Jobs::load(state::jobs_dir());
    eprintln!(
        "hands {VERSION}: supervisor {} listening on {}",
        std::process::id(),
        socket.display()
    );
    {
        let jobs = jobs.clone();
        thread::spawn(move || {
            loop {
                thread::sleep(PRUNE_INTERVAL);
                jobs.prune();
            }
        });
    }
    let accept = move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let jobs = jobs.clone();
            thread::spawn(move || handle(&jobs, stream));
        }
    };
    if crate::permissions::in_service() && cua::start() {
        thread::spawn(accept);
        cua::run_main_loop();
    }
    accept();
    Ok(())
}

/// The operations of the supervisor socket. Not the client's (serve.rs): `job.*` and `cua.*` arrive forwarded by
/// `serve`, the rest come from the CLI.
#[derive(Clone, Copy, PartialEq)]
enum SupervisorOp {
    /// The supervisor's own state (pid, jobs, service, desktop), for `golem-hands doctor`, `golem-hands install` and
    /// `golem-hands permissions`. Not serve's `hello`: the client's `hello` never reaches the supervisor, `serve` answers
    /// it itself.
    Hello,
    /// Ask macOS for a permission on behalf of hands (permissions.rs).
    Access,
    JobStart,
    JobStatus,
    JobOutput,
    JobWait,
    JobCancel,
    JobList,
    CuaTools,
    CuaCall,
    CuaCancel,
    /// Exit after answering; jobs keep running and the next supervisor adopts them.
    Shutdown,
}

impl SupervisorOp {
    fn parse(name: &str) -> Option<SupervisorOp> {
        Some(match name {
            "hello" => SupervisorOp::Hello,
            "access" => SupervisorOp::Access,
            "job.start" => SupervisorOp::JobStart,
            "job.status" => SupervisorOp::JobStatus,
            "job.output" => SupervisorOp::JobOutput,
            "job.wait" => SupervisorOp::JobWait,
            "job.cancel" => SupervisorOp::JobCancel,
            "job.list" => SupervisorOp::JobList,
            "cua.tools" => SupervisorOp::CuaTools,
            "cua.call" => SupervisorOp::CuaCall,
            "cua.cancel" => SupervisorOp::CuaCancel,
            "shutdown" => SupervisorOp::Shutdown,
            _ => return None,
        })
    }
}

fn handle(jobs: &Arc<Jobs>, mut stream: UnixStream) {
    let Ok(Some(request)) = frame::read_frame(&mut stream) else {
        return;
    };
    let name = request.json["op"].as_str().unwrap_or_default();
    let op = SupervisorOp::parse(name);
    let reply = match op {
        Some(op) if !allowed(op, crate::permissions::in_service(), peer_pid(&stream)) => Err(Failure::new(
            "EPERM",
            format!("{name} is only for the connections of this service's listener"),
        )),
        Some(op) => dispatch(jobs, op, name, &request.json),
        None => Err(Failure::new("EINVAL", format!("unknown operation {name}"))),
    };
    let reply = match reply {
        Ok((json, payload)) => Frame::with_payload(RESULT, request.id, json, payload),
        Err(failure) => Frame::new(ERROR, request.id, failure.to_json()),
    };
    let _ = frame::write_frame(&mut stream, &reply);
    if op == Some(SupervisorOp::Shutdown) {
        jobs.exit();
    }
}

/// Whether a peer may ask for `op`. The CLI's operations stay open: `job.list` shows only what the state dir holds.
fn allowed(op: SupervisorOp, in_service: bool, peer: Option<u32>) -> bool {
    match op {
        SupervisorOp::Hello | SupervisorOp::Access | SupervisorOp::Shutdown | SupervisorOp::JobList => true,
        _ => {
            !in_service
                || peer.is_some_and(|pid| SERVE_PIDS.lock().unwrap_or_else(|error| error.into_inner()).contains(&pid))
        }
    }
}

/// The pid of the process at the other end of a Unix socket.
#[cfg(target_os = "macos")]
fn peer_pid(stream: &UnixStream) -> Option<u32> {
    let mut pid: libc::pid_t = 0;
    let mut length = size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: `pid` is writable for `length` bytes for the duration of the call.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&raw mut pid).cast(),
            &mut length,
        )
    };
    (result == 0).then_some(pid).and_then(|pid| u32::try_from(pid).ok()).filter(|pid| *pid != 0)
}

/// The pid of the process at the other end of a Unix socket.
#[cfg(not(target_os = "macos"))]
fn peer_pid(stream: &UnixStream) -> Option<u32> {
    let mut credentials = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut length = size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `credentials` is writable for `length` bytes for the duration of the call.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&raw mut credentials).cast(),
            &mut length,
        )
    };
    (result == 0).then_some(credentials.pid).and_then(|pid| u32::try_from(pid).ok()).filter(|pid| *pid != 0)
}

fn dispatch(jobs: &Arc<Jobs>, op: SupervisorOp, name: &str, json: &Value) -> Result<(Value, Vec<u8>), Failure> {
    let plain = |value: Result<Value, Failure>| value.map(|value| (value, Vec::new()));
    match op {
        SupervisorOp::Hello => {
            let (count, running) = jobs.count();
            plain(Ok(json!({
                "protocol": PROTOCOL,
                "version": VERSION,
                "pid": std::process::id(),
                "stateDir": state::dir(),
                "jobs": count,
                "running": running,
                // Started by launchd or systemd: what macOS asks about is hands itself (permissions.rs).
                "service": crate::permissions::in_service(),
                "desktop": cua::status(),
            })))
        }
        // Blocks this connection's thread while macOS asks the user, the first time.
        SupervisorOp::Access => plain(crate::permissions::access(json)),
        SupervisorOp::JobStart => plain(jobs.start(json)),
        SupervisorOp::JobStatus => plain(jobs.status(json)),
        SupervisorOp::JobOutput => jobs.output(json),
        SupervisorOp::JobWait => plain(jobs.wait(json)),
        SupervisorOp::JobCancel => plain(jobs.cancel(json)),
        SupervisorOp::JobList => plain(Ok(jobs.list())),
        // Calls wait on the desktop; each connection has its own thread.
        SupervisorOp::CuaTools | SupervisorOp::CuaCall | SupervisorOp::CuaCancel => plain(cua::supervise(name, json)),
        SupervisorOp::Shutdown => plain(Ok(json!({}))),
    }
}

fn unavailable(error: impl std::fmt::Display) -> Failure {
    Failure::new(
        "supervisor_unavailable",
        format!("hands supervisor unavailable: {error}"),
    )
}

/// Send one request to the supervisor, starting one first if none runs.
pub fn call(request: &Value) -> Result<(Value, Vec<u8>), Failure> {
    exchange(connect(true)?, request)
}

/// Send one request to a running supervisor; `supervisor_unavailable` if none runs.
pub fn call_running(request: &Value) -> Result<(Value, Vec<u8>), Failure> {
    exchange(connect(false)?, request)
}

fn exchange(mut stream: UnixStream, request: &Value) -> Result<(Value, Vec<u8>), Failure> {
    frame::write_frame(&mut stream, &Frame::new(REQUEST, 1, request.clone()))
        .map_err(unavailable)?;
    match frame::read_frame(&mut stream).map_err(unavailable)? {
        Some(reply) if reply.kind == RESULT => Ok((reply.json, reply.payload)),
        Some(reply) if reply.kind == ERROR => {
            let code = reply.json["code"].as_str().unwrap_or("unknown").to_string();
            let message = reply.json["message"].as_str().unwrap_or_default().to_string();
            Err(Failure::new(&code, message).extra(reply.json))
        }
        _ => Err(unavailable("it closed the connection")),
    }
}

fn connect(start: bool) -> Result<UnixStream, Failure> {
    let socket = state::socket();
    match UnixStream::connect(&socket) {
        Ok(stream) => return Ok(stream),
        Err(error) if !start => return Err(unavailable(error)),
        Err(_) => {}
    }
    start_detached().map_err(unavailable)?;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        match UnixStream::connect(&socket) {
            Ok(stream) => return Ok(stream),
            Err(error) if Instant::now() >= deadline => return Err(unavailable(error)),
            Err(_) => thread::sleep(Duration::from_millis(20)),
        }
    }
}

/// Start `golem-hands supervise --detached` in a new session, so it outlives this process.
fn start_detached() -> io::Result<()> {
    state::ensure()?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(state::log())?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args(["supervise", "--detached"])
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    // Reap it if it exits while this process lives (another supervisor won the lock); otherwise init adopts it.
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_service_only_serve_children_use_jobs_and_the_desktop() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        let me = peer_pid(&ours);
        assert_eq!(me, Some(std::process::id()));
        for op in [SupervisorOp::JobStart, SupervisorOp::JobOutput, SupervisorOp::CuaCall, SupervisorOp::CuaCancel] {
            assert!(allowed(op, false, None), "outside the service everything stays open");
            assert!(!allowed(op, true, None));
            assert!(!allowed(op, true, me));
        }
        for op in [SupervisorOp::Hello, SupervisorOp::Access, SupervisorOp::Shutdown, SupervisorOp::JobList] {
            assert!(allowed(op, true, None), "the CLI's operations stay open");
        }
        SERVE_PIDS.lock().unwrap().insert(std::process::id());
        assert!(allowed(SupervisorOp::JobStart, true, me));
        assert!(allowed(SupervisorOp::CuaCall, true, me));
        SERVE_PIDS.lock().unwrap().remove(&std::process::id());
        assert!(!allowed(SupervisorOp::JobStart, true, me));
    }
}
