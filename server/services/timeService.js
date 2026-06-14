export const DEFAULT_TIME_ZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const formatterCache = new Map();

export function resolveTimeZone(...values) {
  const candidate = values.find(value => typeof value === 'string' && value.trim());
  const timeZone = candidate?.trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function nowUtcIso() {
  return new Date().toISOString();
}

export function addHoursUtc(date = new Date(), hours = 0) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

export function getZonedHour(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return getZonedParts(date, timeZone).hour;
}

export function nextLocalTimeUtc({
  from = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  hour,
  minute = 0,
  second = 0,
  forceTomorrow = false,
} = {}) {
  const zone = resolveTimeZone(timeZone);
  const parts = getZonedParts(from, zone);
  const dayOffset = forceTomorrow ? 1 : 0;
  let local = addLocalDays({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute,
    second,
  }, dayOffset);

  let candidate = zonedDateTimeToUtc(local, zone);
  if (!forceTomorrow && candidate <= from) {
    local = addLocalDays(local, 1);
    candidate = zonedDateTimeToUtc(local, zone);
  }

  return candidate.toISOString();
}

export function localDateTimeToUtcIso({
  localDateTime,
  timeZone = DEFAULT_TIME_ZONE,
} = {}) {
  const raw = String(localDateTime || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const local = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
  };

  if (
    !Number.isInteger(local.year) ||
    !Number.isInteger(local.month) ||
    !Number.isInteger(local.day) ||
    !Number.isInteger(local.hour) ||
    !Number.isInteger(local.minute) ||
    local.month < 1 ||
    local.month > 12 ||
    local.day < 1 ||
    local.day > 31 ||
    local.hour < 0 ||
    local.hour > 23 ||
    local.minute < 0 ||
    local.minute > 59
  ) {
    return null;
  }

  return zonedDateTimeToUtc(local, resolveTimeZone(timeZone)).toISOString();
}

export function getLocalDateTimeContext(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const zone = resolveTimeZone(timeZone);
  const parts = getZonedParts(date, zone);
  const pad = value => String(value).padStart(2, '0');
  return {
    timeZone: zone,
    date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour)}:${pad(parts.minute)}`,
    localDateTime: `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`,
  };
}

export function formatInTimeZone(value, {
  timeZone = DEFAULT_TIME_ZONE,
  locale = 'en-IN',
  dateStyle = 'medium',
  timeStyle = 'short',
} = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'the scheduled time';
  return date.toLocaleString(locale, {
    timeZone: resolveTimeZone(timeZone),
    dateStyle,
    timeStyle,
  });
}

function getFormatter(timeZone) {
  const zone = resolveTimeZone(timeZone);
  if (!formatterCache.has(zone)) {
    formatterCache.set(zone, new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }));
  }
  return formatterCache.get(zone);
}

function getZonedParts(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = Object.fromEntries(
    getFormatter(timeZone).formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function zonedDateTimeToUtc(local, timeZone) {
  const targetLocalAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour || 0,
    local.minute || 0,
    local.second || 0,
    0
  );
  let utcMs = targetLocalAsUtc;

  for (let i = 0; i < 3; i += 1) {
    const parts = getZonedParts(new Date(utcMs), timeZone);
    const asIfUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0
    );
    utcMs += targetLocalAsUtc - asIfUtc;
  }

  return new Date(utcMs);
}

function addLocalDays(local, days) {
  const shifted = new Date(Date.UTC(
    local.year,
    local.month - 1,
    local.day + days,
    local.hour || 0,
    local.minute || 0,
    local.second || 0,
    0
  ));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}
