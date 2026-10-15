import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export { dayjs };

export const startOfToday = (tz?: string) =>
  (tz ? dayjs().tz(tz) : dayjs()).startOf('day').toDate();

export const endOfToday = (tz?: string) => (tz ? dayjs().tz(tz) : dayjs()).endOf('day').toDate();

export const inDays = (days: number) => dayjs().add(days, 'day').toDate();

export const isOverdue = (due: Date | null | undefined) =>
  Boolean(due && dayjs(due).isBefore(dayjs()));

export const formatDate = (date: Date | null | undefined, tz = 'Asia/Phnom_Penh') =>
  date ? dayjs(date).tz(tz).format('D MMM YYYY') : '—';

export const formatDateTime = (date: Date | null | undefined, tz = 'Asia/Phnom_Penh') =>
  date ? dayjs(date).tz(tz).format('D MMM YYYY, HH:mm') : '—';

export const relative = (date: Date) => {
  const diff = dayjs(date).diff(dayjs(), 'hour');
  if (Math.abs(diff) < 1) return 'less than an hour';
  if (Math.abs(diff) < 24) return `${Math.abs(diff)}h`;
  return `${Math.abs(dayjs(date).diff(dayjs(), 'day'))}d`;
};
