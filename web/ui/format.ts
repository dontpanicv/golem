/** A time span as 8s, 2m 05s, or 1h 03m. */
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** 14:05 */
export function clockTime(milliseconds: number): string {
  return new Date(milliseconds).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 26 Oct, 14:05 */
export function dayTime(milliseconds: number): string {
  return new Date(milliseconds).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Mon 26 Oct, 14:05 */
export function weekdayTime(milliseconds: number): string {
  return new Date(milliseconds).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 26 Oct */
export function day(milliseconds: number): string {
  return new Date(milliseconds).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

/** 12 KB or 3.4 MB */
export function size(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 1 person, 3 people */
export function people(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}
