export type DateFormatOptions = {
  includeTime?: boolean;
  timeZone?: string;
};

function ordinal(day: number) {
  const lastTwo = day % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${day}th`;
  if (day % 10 === 1) return `${day}st`;
  if (day % 10 === 2) return `${day}nd`;
  if (day % 10 === 3) return `${day}rd`;
  return `${day}th`;
}

export function formatEnglishDate(value: string | number | Date, { includeTime = false, timeZone }: DateFormatOptions = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const dateParts = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
    ...(timeZone ? { timeZone } : {})
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => dateParts.find((item) => item.type === type)?.value || "";
  const formatted = `${part("month")} ${ordinal(Number(part("day")))}, ${part("year")}`;
  if (!includeTime) return formatted;
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {})
  }).format(date);
  return `${formatted} at ${time}`;
}
