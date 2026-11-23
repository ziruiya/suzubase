// P3-C (fixed cadence): local-calendar slot computation for schedule.fixed
// triggers. All local <-> UTC conversion goes through the platform IANA
// timezone database via Intl (Node ICU) -- no hand-written offset tables.
// A slot is identified by a stable slot key derived from its scheduled
// LOCAL date, so the same calendar period always maps to the same key no
// matter when the worker happens to scan it.

export type Cadence = 'daily' | 'weekly' | 'monthly';
export type MissedRunPolicy = 'skip' | 'catch_up_latest';

export interface FixedScheduleConfig {
  cadence: Cadence;
  localTime: string; // 'HH:MM', 24h
  timezone: string; // IANA identifier
  weekdays?: number[]; // weekly only: 0 = Sunday .. 6 = Saturday
  monthDay?: number; // monthly only: 1..31 (clamped to the month's last day)
  missedRunPolicy?: MissedRunPolicy;
}

export interface ScheduleSlot {
  slotKey: string; // '<cadence>:<local date ISO>'
  localDate: string; // 'YYYY-MM-DD' in the rule timezone
  utc: Date; // scheduled instant (pseudo-instant when the local time does not exist)
  exists: boolean; // false when the local time falls in a DST gap
}

const DAY_MS = 86_400_000;

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function isValidLocalTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function partsInZone(instant: Date, timezone: string) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const byType = new Map(formatted.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.get('year')), month: Number(byType.get('month')), day: Number(byType.get('day')),
    hour: Number(byType.get('hour')) % 24, minute: Number(byType.get('minute')), second: Number(byType.get('second')),
  };
}

// Offset (local - UTC) in milliseconds for the zone at an instant, derived
// from Intl parts; minute precision is enough for civil timezones.
function zoneOffsetMs(instant: Date, timezone: string): number {
  const parts = partsInZone(instant, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

interface LocalDateTime { year: number; month: number; day: number; hour: number; minute: number }

// Resolve a local wall-clock time to UTC. Returns every distinct UTC
// instant whose zone rendering equals the requested local time: zero in a
// DST gap (nonexistent), two in a DST fold (ambiguous), one otherwise.
export function localTimeToUtcCandidates(local: LocalDateTime, timezone: string): Date[] {
  const pseudo = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const candidates = new Set<number>();
  for (const probeDelta of [-2 * DAY_MS, -DAY_MS, -12 * 3_600_000, 0, 12 * 3_600_000, DAY_MS, 2 * DAY_MS]) {
    let candidate = pseudo - zoneOffsetMs(new Date(pseudo + probeDelta), timezone);
    for (let i = 0; i < 3; i++) {
      const refined = pseudo - zoneOffsetMs(new Date(candidate), timezone);
      if (refined === candidate) break;
      candidate = refined;
    }
    const rendered = partsInZone(new Date(candidate), timezone);
    if (rendered.year === local.year && rendered.month === local.month && rendered.day === local.day &&
      rendered.hour === local.hour && rendered.minute === local.minute) {
      candidates.add(candidate);
    }
  }
  return [...candidates].sort((a, b) => a - b).map((ms) => new Date(ms));
}

function localDateOf(instant: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = partsInZone(instant, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function cadenceMatches(config: FixedScheduleConfig, year: number, month: number, day: number): boolean {
  if (config.cadence === 'daily') return true;
  if (config.cadence === 'weekly') return (config.weekdays ?? []).includes(weekdayOf(year, month, day));
  // monthly: the configured day, clamped to the month's last day when the
  // configured day does not exist (brief 3.1 month-end rule).
  return day === Math.min(config.monthDay ?? 1, lastDayOfMonth(year, month));
}

export function slotForLocalDate(config: FixedScheduleConfig, year: number, month: number, day: number): ScheduleSlot {
  const [hour, minute] = config.localTime.split(':').map(Number);
  const localDate = isoDate(year, month, day);
  const candidates = localTimeToUtcCandidates({ year, month, day, hour, minute }, config.timezone);
  if (!candidates.length) {
    // DST gap: keep a pseudo-instant (the wall time read as if the
    // pre-transition offset applied) so the slot still becomes due and
    // the worker can record SKIPPED_NONEXISTENT_TIME and move on.
    const pseudo = Date.UTC(year, month - 1, day, hour, minute);
    const utc = new Date(pseudo - zoneOffsetMs(new Date(pseudo - DAY_MS), config.timezone));
    return { slotKey: `${config.cadence}:${localDate}`, localDate, utc, exists: false };
  }
  // DST fold: only the first occurrence executes (brief 3.1).
  return { slotKey: `${config.cadence}:${localDate}`, localDate, utc: candidates[0], exists: true };
}

// Enumerate slots whose scheduled local date falls in the local-date
// window around `from`..`to` (instants). Used both for next-due
// computation and for listing due slots; bounded by maxDays.
export function enumerateSlots(config: FixedScheduleConfig, from: Date, to: Date): ScheduleSlot[] {
  const start = localDateOf(from, config.timezone);
  const end = localDateOf(to, config.timezone);
  const slots: ScheduleSlot[] = [];
  let cursor = Date.UTC(start.year, start.month - 1, start.day) - 2 * DAY_MS;
  const last = Date.UTC(end.year, end.month - 1, end.day) + 2 * DAY_MS;
  for (let guard = 0; cursor <= last && guard < 5000; guard++) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
    if (cadenceMatches(config, year, month, day)) {
      const slot = slotForLocalDate(config, year, month, day);
      if (slot.utc >= from && slot.utc <= to) slots.push(slot);
    }
    cursor += DAY_MS;
  }
  return slots.sort((a, b) => a.utc.getTime() - b.utc.getTime() || a.slotKey.localeCompare(b.slotKey));
}

// First slot strictly after `after` (the next valid period).
export function nextSlotAfter(config: FixedScheduleConfig, after: Date): ScheduleSlot {
  const start = localDateOf(after, config.timezone);
  let cursor = Date.UTC(start.year, start.month - 1, start.day) - 2 * DAY_MS;
  for (let i = 0; i < 400; i++) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
    if (cadenceMatches(config, year, month, day)) {
      const slot = slotForLocalDate(config, year, month, day);
      if (slot.utc > after) return slot;
    }
    cursor += DAY_MS;
  }
  throw new Error('No schedule slot found within 400 days');
}

// ---------------------------------------------------------------------
// P3-C date-relative (T-3 lower half): a plan's due instant is a source
// local date (a record's date-field value, or the record's creation date
// in the tenant timezone) shifted by a signed day offset, at a fixed
// local wall-clock time in the rule's IANA timezone.
// ---------------------------------------------------------------------

export interface DateRelativeConfig {
  source: 'field' | 'createdAt';
  fieldId?: string; // required when source === 'field'
  offsetDays: number; // signed: negative = before the source date
  localTime: string; // 'HH:MM', 24h
  timezone: string; // IANA identifier
}

// Stable plan identity fragment: encodes the trigger elements (source
// field, offset magnitude AND direction, execution wall time). The same
// rule version + record + key always denotes the same logical plan.
export function dateRelativeScheduleKey(config: DateRelativeConfig): string {
  const source = config.source === 'field' ? `field:${config.fieldId}` : 'createdAt';
  const offset = config.offsetDays >= 0 ? `+${config.offsetDays}` : `${config.offsetDays}`;
  return `daterel:${source}:${offset}d:${config.localTime}`;
}

export function addDaysToIsoDate(sourceIso: string, days: number): string {
  const [year, month, day] = sourceIso.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return isoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

export function isoDateInZone(instant: Date, timezone: string): string {
  const parts = localDateOf(instant, timezone);
  return isoDate(parts.year, parts.month, parts.day);
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

// Resolve "source local date + offset days, at localTime" to a UTC
// instant. A wall time inside a DST gap resolves to the pseudo-instant
// (pre-transition offset), matching the cadence gap handling for the
// instant itself; a fold resolves to the first occurrence.
export function dateRelativeDueAt(sourceLocalDate: string, config: DateRelativeConfig): { dueAt: Date; localDate: string } {
  const localDate = addDaysToIsoDate(sourceLocalDate, config.offsetDays);
  const [year, month, day] = localDate.split('-').map(Number);
  const [hour, minute] = config.localTime.split(':').map(Number);
  const candidates = localTimeToUtcCandidates({ year, month, day, hour, minute }, config.timezone);
  if (candidates.length) return { dueAt: candidates[0], localDate };
  const pseudo = Date.UTC(year, month - 1, day, hour, minute);
  return { dueAt: new Date(pseudo - zoneOffsetMs(new Date(pseudo - DAY_MS), config.timezone)), localDate };
}

// The slot with the given key, recomputed deterministically (used when a
// persisted plan resumes: the key is the identity, the instant is derived).
export function slotByKey(config: FixedScheduleConfig, slotKey: string): ScheduleSlot | null {
  const match = /^([a-z]+):(\d{4})-(\d{2})-(\d{2})$/.exec(slotKey);
  if (!match || match[1] !== config.cadence) return null;
  const year = Number(match[2]), month = Number(match[3]), day = Number(match[4]);
  if (!cadenceMatches(config, year, month, day)) return null;
  return slotForLocalDate(config, year, month, day);
}
