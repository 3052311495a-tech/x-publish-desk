export const DELIVERY_TIME_ZONES = ['America/Los_Angeles', 'Asia/Shanghai'] as const;
export type DeliveryTimeZone = typeof DELIVERY_TIME_ZONES[number];

// Reuse formatters, not date results: DST offsets and the current-time check
// must still be evaluated for every selected time.
const formatters = new Map<DeliveryTimeZone, Intl.DateTimeFormat>();

function partsAt(epoch: number, timeZone: DeliveryTimeZone): number[] {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(epoch));
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(name => Number(parts.find(part => part.type === name)?.value));
}

function utc(parts: number[]): number {
  // setUTCFullYear avoids Date.UTC's special treatment of years below 100.
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3], parts[4], parts[5] || 0, 0);
  return date.getTime();
}

/** Convert an explicit wall clock + IANA zone without relying on the Mac zone.
 * Both nonexistent and repeated DST times are rejected, never guessed. */
export function parseDeliveryTime(value: string, timeZone: string, now = Date.now()): string {
  if (!DELIVERY_TIME_ZONES.includes(timeZone as DeliveryTimeZone)) throw new Error('请选择明确的发布时区');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('请填写完整的发布日期和时间');
  const target = match.slice(1).map(Number).concat(0);
  const wall = utc(target), check = new Date(wall);
  if (target[0] < 2000 || check.getUTCFullYear() !== target[0]
    || check.getUTCMonth() + 1 !== target[1] || check.getUTCDate() !== target[2]
    || check.getUTCHours() !== target[3] || check.getUTCMinutes() !== target[4]) {
    throw new Error('发布日期或时间不正确');
  }
  const zone = timeZone as DeliveryTimeZone, offsets = new Set<number>();
  // Sampling either side of a transition finds both relevant UTC offsets.
  for (let hours = -36; hours <= 36; hours += 6) {
    const epoch = wall + hours * 3_600_000;
    offsets.add(utc(partsAt(epoch, zone)) - epoch);
  }
  const candidates = [...offsets].map(offset => wall - offset)
    .filter(epoch => partsAt(epoch, zone).every((value, index) => value === target[index]));
  if (!candidates.length) throw new Error('这个时刻因夏令时切换不存在，请换一个时间');
  if (candidates.length > 1) throw new Error('这个时刻因夏令时切换会出现两次，请换一个时间');
  if (candidates[0] <= now) throw new Error('发布时间必须晚于现在');
  return new Date(candidates[0]).toISOString();
}

export function formatDeliveryTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || !DELIVERY_TIME_ZONES.includes(timeZone as DeliveryTimeZone)) return iso;
  const [year, month, day, hour, minute] = partsAt(date.getTime(), timeZone as DeliveryTimeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} · ${timeZone}`;
}

export function defaultDeliveryTime(timeZone: DeliveryTimeZone, now = Date.now()): string {
  const [year, month, day, hour, minute] = partsAt(now + 3_600_000, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Only verified public X status URLs are opened from a delivery receipt. */
export function deliveryResultUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)
      && /^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(url.pathname)
      && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
