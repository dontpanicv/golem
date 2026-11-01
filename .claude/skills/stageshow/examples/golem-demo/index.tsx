import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Bar, Collapse, Count, Phone, Roll, Stage, States, Stream, Window, useLook, type Act, type Layout } from '../../kit'
import './golem.css'

// Golem, the family assistant, in its own desktop look: the sidebar on the
// canvas, the thread in an inset panel, Inter, the clay accent. Beats: a
// person types a request into the composer and sends it; Golem's face starts
// to work ("Working for 1s · Set heating", the pixel spinner, a shimmer), its
// step changes twice; the work folds into "Worked for 3s" with one gold
// pixel for each tool call; the answer streams in, its three cards drop in
// under the first line, and the last line streams under them. The payoff
// holds, then the exchange leaves in one reverse stagger around the earlier
// thread, which comes back down to where the loop began.
//
// Golem's look is taken from its code, not invented: the face and the card
// icons are the pixel paths of web/ui/components.tsx and web/threads/cards.tsx,
// the glyphs are web/ui/icon.tsx, the sizes and colors are public/tokens.css
// and public/styles.css (.message, .work-summary, .step-strip, .card,
// .composer, .panel).
//
// Real strings: the request, the work line, the answer's two lines, the
// three cards, and the short turn before them; the sidebar's own nav and the
// thread title are chrome. Older turns are placeholder.

const Q = 'We land at 18:40. Warm the living room up before we get home, and tell me if it rains tonight.'
// The non-breaking space keeps the value one word, so it streams and bolds as one
const A1 = 'Done. The living room heats to 22 °C from 18:30, so it is warm when you come in at about 19:30.'
const A2 = 'Light rain starts at 21:00, so take the umbrella from the car.'
const W1 = A1.split(' ').length
const W2 = A2.split(' ').length
const STEPS = ['Set heating', 'Get forecast', 'Get car']

const CARDS = [
  { icon: 'heat', title: 'Living room', value: '17.2 → 22 °C', detail: 'from 18:30' },
  { icon: 'rain', title: 'Tonight', value: 'Rain at 21:00', detail: '70 %, light' },
  { icon: 'battery', title: 'Car', value: '78 %', detail: '412 km' },
] as const

// web/threads/cards.tsx: the pixel icons of cards, in the cells of an 8 × 8 grid
const PIXELS = {
  heat: 'M4 0H5V1H6V3H7V6H6V7H5V8H3V7H2V6H1V3H2V2H3V1H4Z',
  rain: 'M2 1H5V2H6V3H7V5H1V4H0V3H1V2H2ZM1 6H2V7H1ZM3 6H4V8H3ZM5 6H6V7H5Z',
  battery: 'M0 2H7V3H8V5H7V6H0ZM1 3V5H4V3Z',
}

// web/ui/icon.tsx: 16 px stroke icons
const GLYPHS = {
  golem: '<svg x="1.142857" y="1.142857" width="13.714286" height="13.714286" viewBox="0 0 8 8" shape-rendering="crispEdges"><path d="M0 0H8V7H7V8H1V7H0ZM3 1H5V2H3ZM2 5H6V6H2ZM1 2H3V3H1ZM5 2H7V3H5Z" fill="currentColor" fill-rule="evenodd" stroke="none"/></svg>',
  bell: '<path d="M4.5 11V7a3.5 3.5 0 0 1 7 0v4l1 1.5h-9z"/><path d="M6.75 14h2.5"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  hash: '<path d="M6 2.5 5 13.5M11 2.5l-1 11M2.5 6h11M2 10h11"/>',
  compose: '<path d="M13 8.5V13a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 13V4a.5.5 0 0 1 .5-.5H8"/><path d="m12 2.5 1.5 1.5L8 9.5 6 10l.5-2z"/>',
  panel: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>',
  attach: '<path d="m13 7.5-5 5a3 3 0 0 1-4.5-4.5l5.5-5.5a2 2 0 0 1 3 3L6.5 11a1 1 0 0 1-1.5-1.5L10 4.5"/>',
  send: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  disclosure: '<path d="M6.5 5.25v5.5L10.25 8z" fill="currentColor" stroke="none"/>',
}

type Phase = 'idle' | 'working' | 'worked'
type S = {
  draft: string
  sent: boolean
  phase: Phase
  elapsed: number
  step: number
  w1: number
  cards: boolean
  w2: number
  leaving: boolean
}

const initial: S = { draft: '', sent: false, phase: 'idle', elapsed: 1, step: 0, w1: 0, cards: false, w2: 0, leaving: false }
const poster: S = { draft: '', sent: true, phase: 'worked', elapsed: 3, step: 2, w1: W1, cards: true, w2: W2, leaving: false }

const REST = { wide: { x: 812, y: 512 }, compact: { x: 236, y: 544 } }

async function script(a: Act<S>) {
  await a.wait(600)
  a.mark('type')
  await a.type('draft', Q, { interval: 26 })
  await a.wait(250)
  a.mark('send')
  await a.click({ at: 'send', x: 0.5, y: 0.5 })
  // The message starts to land before the composer empties, so the words are
  // never gone from both
  a.put({ sent: true })
  void a.move(REST)
  await a.wait(180)
  a.put({ draft: '' })
  await a.wait(450)

  // Golem works: its step changes as each tool call starts
  a.mark('work')
  a.put({ phase: 'working' })
  await a.wait(1000)
  a.put({ elapsed: 2, step: 1 })
  await a.wait(1000)
  a.put({ elapsed: 3, step: 2 })
  await a.wait(900)

  a.mark('worked')
  a.put({ phase: 'worked' })
  await a.wait(450)

  a.mark('stream')
  for (let i = 1; i <= W1; i++) {
    a.put({ w1: i })
    await a.wait(38)
  }
  await a.wait(250)
  a.mark('cards')
  a.put({ cards: true })
  await a.wait(750)
  for (let i = 1; i <= W2; i++) {
    a.put({ w2: i })
    await a.wait(38)
  }

  a.mark('payoff')
  await a.wait(2600)

  // The exchange fades out as one, then the earlier thread comes back down
  // into its room, so the two never show at once
  a.mark('exit')
  a.put({ leaving: true })
  await a.wait(100)
  a.put({ sent: false, phase: 'idle', w1: 0, cards: false, w2: 0 })
  await a.wait(600)
  await a.snap({ elapsed: 1, step: 0, leaving: false })
  await a.wait(100)
}

export default function GolemDemo() {
  // A phone is touched, never pointed at: the phone column gets the touch
  // cursor. The stage switches to compact below 600, so this does too
  const column = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setNarrow(entry!.contentRect.width < 600))
    observer.observe(column.current!)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={column}>
    <Stage
      width={960}
      height={564}
      compact={{ below: 600, width: 358, height: 624 }}
      initial={initial}
      poster={poster}
      script={script}
      cursor={{ at: REST, style: narrow ? 'touch' : 'real' }}
      className="gd"
    >
      {(s, _rect, layout) => <Scene s={s} layout={layout} />}
    </Stage>
    </div>
  )
}

function Scene({ s, layout }: { s: S; layout: Layout }) {
  const { theme } = useLook()
  // The phone column gets Golem's iOS app: the same thread, cropped at the
  // top so the composer and its send button stay whole
  if (layout === 'compact') {
    return (
      <Phone width={326} dark={theme === 'dark'} className="gd-phone">
        <Thread s={s} ios />
      </Phone>
    )
  }
  return (
    <Window className="gd-window" sidebar={<Sidebar />} sidebarWidth={200} lead={<Header />} toolbar={<span className="gd-tool"><Glyph name="panel" /></span>} body={{ className: 'gd-panel' }}>
      <Thread s={s} />
    </Window>
  )
}

function Header() {
  return (
    <span className="gd-title">
      <span className="gd-crumb">general ›</span> Flight home
    </span>
  )
}

function Sidebar() {
  return (
    <nav className="gd-side">
      <div className="gd-nav">
        <NavItem icon="golem" label="Golem" />
        <NavItem icon="bell" label="Inbox" />
        <NavItem icon="clock" label="Upcoming" />
        <NavItem icon="search" label="Search" />
      </div>
      <div className="gd-nav">
        <div className="gd-section">Channels</div>
        <NavItem icon="hash" label="general" />
        <div className="gd-sub">
          <NavItem icon="compose" label="Flight home" current />
          <span className="gd-nav-item"><Glyph name="compose" /><Bar w={64} h={5} tone={2} /></span>
        </div>
        {[44, 58, 36, 50, 40, 62, 46].map((w, i) => (
          <span className="gd-nav-item" key={i}><Glyph name="hash" /><Bar w={w} h={5} tone={2} /></span>
        ))}
      </div>
    </nav>
  )
}

function NavItem({ icon, label, current }: { icon: keyof typeof GLYPHS; label: string; current?: boolean }) {
  return (
    <span className="gd-nav-item" data-current={current || undefined}>
      <Glyph name={icon} />
      <span className="gd-nav-label">{label}</span>
    </span>
  )
}

function Thread({ s, ios }: { s: S; ios?: boolean }) {
  const working = s.phase === 'working'
  return (
    <div className="gd-body" data-ios={ios || undefined}>
      <div className="gd-transcript">
        {/* Earlier turns as placeholder: they fill the pane at the start and
            go up out of it as the answer grows */}
        <Message author={<Face mood="icon" />} name={40} lines={['80%', '62%', '34%']} />
        <Message author={<Person />} name={36} lines={['66%', '52%', '30%']} />
        <Message author={<Face mood="icon" />} name={40} lines={['86%', '70%', '44%']} />
        {/* The turns before are real, so the thread opens on real messages */}
        <Said author="Mia" time="07:36" text="Is the house locked?" />
        <Said author="Golem" time="07:36" text="Yes, both doors are locked." />
        <Said author="Mia" time="07:40" text="Our flight home leaves at 16:20." />
        <Said author="Golem" time="07:40" text="Have a safe flight." />

        <Collapse open={s.sent} reveal="drop" from="below" className="gd-new" data-leaving={s.leaving || undefined}>
          <div className="gd-message">
            <Person />
            <div className="gd-message-body">
              <Meta author="Mia" time="16:05" />
              <p className="gd-text">{Q}</p>
            </div>
          </div>
        </Collapse>

        <Collapse open={s.phase !== 'idle'} reveal="drop" from="below" className="gd-new" data-leaving={s.leaving || undefined}>
          <div className="gd-message">
            <Face mood={working ? 'working' : 'done'} />
            <div className="gd-message-body">
              <Meta author="Golem" time="16:05" />
              <States
                className="gd-work"
                align="start"
                value={working ? 'working' : 'worked'}
                states={{
                  working: (
                    <span className="gd-work-summary">
                      <PixelSpinner />
                      <span className="gd-shimmer">Working for <Count value={s.elapsed} format={(n) => `${n}s`} duration={420} /></span>
                      <span className="gd-work-now"><Roll variant="fade">{STEPS[s.step]!}</Roll></span>
                    </span>
                  ),
                  worked: (
                    <span className="gd-work-summary">
                      Worked for 3s
                      <span className="gd-disclosure"><Glyph name="disclosure" /></span>
                      <span className="gd-strip" data-on={s.phase === 'worked' || undefined}>
                        {STEPS.map((step) => <i key={step} />)}
                      </span>
                    </span>
                  ),
                }}
              />
              <div className="gd-prose">
                <Collapse open={s.w1 > 0}>
                  <p className="gd-text"><Stream text={A1} count={s.w1} mark={(word) => word.startsWith('22')} /></p>
                </Collapse>
                <Collapse open={s.cards} reveal="drop">
                  <div className="gd-cards" data-on={s.cards || undefined}>
                    {CARDS.map((card) => (
                      <div className="gd-card" key={card.title}>
                        <svg aria-hidden="true" className="gd-card-icon" shapeRendering="crispEdges" viewBox="-2 -2 12 12">
                          <path d={PIXELS[card.icon]} fillRule="evenodd" />
                        </svg>
                        <div className="gd-card-text">
                          <span className="gd-card-title">{card.title}</span>
                          <strong className="gd-card-value">{card.value}</strong>
                          <span className="gd-card-detail">{card.detail}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Collapse>
                <Collapse open={s.w2 > 0}>
                  <p className="gd-text"><Stream text={A2} count={s.w2} /></p>
                </Collapse>
              </div>
            </div>
          </div>
        </Collapse>
      </div>

      <div className="gd-composer">
        {ios && <span className="gd-add"><Glyph name="plus" /></span>}
        <Grow className="gd-input">
          {/* Leaves on the first character, fades back once the composer empties */}
          <span className="gd-placeholder" data-typing data-hidden={s.draft ? true : undefined}>Message #general</span>
          {s.draft}
          {/* Keyed on the length, so every keystroke restarts the blink from solid */}
          {s.draft && <span key={s.draft.length} className="gd-caret" />}
        </Grow>
        <div className="gd-actions">
          {!ios && <span className="gd-attach"><Glyph name="attach" /></span>}
          <span className="gd-send" data-target="send" data-cursor="pointer"><Glyph name="send" /></span>
        </div>
      </div>
    </div>
  )
}

// The composer grows a line at a time as the request wraps, and back on send,
// easing its height so the thread above moves with it instead of jumping
function Grow({ className, children }: { className: string; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    const node = inner.current!
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return (
    <div className="gd-grow" style={{ height }}>
      {/* The text itself wraps at once as it is typed; the box around it eases */}
      <div ref={inner} className={className} data-snap>{children}</div>
    </div>
  )
}

function Message({ author, name, lines }: { author: ReactNode; name: number; lines: string[] }) {
  return (
    <div className="gd-message gd-past">
      {author}
      <div className="gd-message-body">
        <span className="gd-meta"><Bar w={name} h={6} tone={3} /><Bar w={28} h={5} tone={2} /></span>
        <span className="gd-past-lines">
          {lines.map((w, i) => <Bar key={i} w={w} h={7} r={3} tone={2} />)}
        </span>
      </div>
    </div>
  )
}

function Said({ author, time, text }: { author: 'Mia' | 'Golem'; time: string; text: string }) {
  return (
    <div className="gd-message">
      {author === 'Mia' ? <Person /> : <Face mood="icon" />}
      <div className="gd-message-body">
        <Meta author={author} time={time} />
        <p className="gd-text">{text}</p>
      </div>
    </div>
  )
}

function Meta({ author, time }: { author: string; time: string }) {
  return (
    <span className="gd-meta">
      <span className="gd-author">{author}</span>
      <span className="gd-time">{time}</span>
    </span>
  )
}

function Person() {
  return <span className="gd-avatar" aria-hidden="true">M</span>
}

// web/ui/components.tsx (Mark): the eyes and the mouth of each mood
const FACES = {
  icon: { eyes: 'M1 2H3V3H1ZM5 2H7V3H5Z', mouth: 'M2 5H6V6H2Z' },
  working: { eyes: 'M2 2H3V3H2ZM6 2H7V3H6Z', mouth: 'M2 5H6V6H2Z' },
  done: { eyes: 'M1 2H3V3H1ZM5 2H7V3H5Z', mouth: 'M1 4H2V5H1ZM6 4H7V5H6ZM2 5H6V6H2Z' },
}

function Face({ mood }: { mood: keyof typeof FACES }) {
  // Every mood stays drawn, so a change of mood crossfades instead of swapping
  const moods = mood === 'icon' ? (['icon'] as const) : (['working', 'done'] as const)
  return (
    <svg aria-hidden="true" className="gd-face" data-mood={mood} shapeRendering="crispEdges" viewBox="-1 -1 10 10">
      <rect fill="#09090a" height="10" width="10" x="-1" y="-1" />
      <path d="M0 0H8V7H7V8H1V7H0Z" fill="#b8703f" />
      <path d="M3 1H5V2H3Z" fill="#3a1d0c" />
      {moods.map((m) => (
        <g key={m} className="gd-face-mood" data-on={m === mood || undefined}>
          <path d={FACES[m].mouth} fill="#3a1d0c" />
          <path className={m === 'working' ? 'gd-face-eyes' : undefined} d={FACES[m].eyes} fill="#ffd27a" />
        </g>
      ))}
    </svg>
  )
}

function PixelSpinner() {
  return (
    <span className="gd-spinner" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg
      aria-hidden="true"
      className="gd-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      dangerouslySetInnerHTML={{ __html: GLYPHS[name] }}
    />
  )
}
