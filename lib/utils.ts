export function toNumber(value: any) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

const CN_TIMEZONE = 'Asia/Shanghai';
const cnFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CN_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function toDateString(value: any) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = cnFormatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value || '';
  const month = parts.find((p) => p.type === 'month')?.value || '';
  const day = parts.find((p) => p.type === 'day')?.value || '';
  if (!year || !month || !day) return '';
  return `${year}-${month}-${day}`;
}

export function formatPct(value: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatNumber(value: number | null, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return Number(value).toFixed(digits);
}

export function formatMoney(value: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatMoneyWithSymbol(value: number | null, symbol = '¥') {
  const text = formatMoney(value);
  return text === '--' ? text : `${symbol}${text}`;
}

export function containsCjk(text: string) {
  return /[\u4e00-\u9fff]/.test(text);
}

export function classByValue(value: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  if (value > 0) return 'market-up';
  if (value < 0) return 'market-down';
  return 'market-flat';
}

export function normalizeCode(code: string) {
  const raw = String(code || '').trim();
  if (!raw) return '';
  const digits = raw.match(/\d+/g);
  const merged = digits ? digits.join('') : '';
  if (!merged) return '';
  return merged.length < 6 ? merged.padStart(6, '0') : merged;
}
