import type { BatchTradeInput, TradeTiming } from './types';

export type FundCandidate = {
  code: string;
  name?: string;
};

export function parseBatchText(text: string): BatchTradeInput[] {
  if (!text) return [];
  const currentYear = new Date().getFullYear();
  const normalizeDigits = (value: string) =>
    value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 65248));
  const normalizeLine = (value: string) =>
    normalizeDigits(value)
      .replace(/[，]/g, ',')
      .replace(/[．。]/g, '.')
      .replace(/[／]/g, '/')
      .replace(/[－—–]/g, '-')
      .replace(/[：]/g, ':')
      .replace(/\s+/g, ' ')
      .trim();
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const items: BatchTradeInput[] = [];
  let pending: Partial<BatchTradeInput> | null = null;

  const createBatchId = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  let lastAddedLineIndex: number | null = null;
  const finalize = (entry: Partial<BatchTradeInput>, lineIndex: number) => {
    if (!entry.type || !entry.date) return;
    if (entry.amount === null && entry.shares === null) return;
    items.push({
      id: createBatchId(),
      type: entry.type,
      amount: entry.amount ?? null,
      shares: entry.shares ?? null,
      date: entry.date,
      time: entry.time ?? null,
      timing: entry.timing || 'before',
      raw: entry.raw
    });
    lastAddedLineIndex = lineIndex;
  };

  const parseTiming = (time: string | null | undefined) => {
    if (!time) return 'before' as TradeTiming;
    const [h, m] = time.split(':').map((value) => Number(value));
    if (Number.isFinite(h) && Number.isFinite(m)) {
      return h > 15 || (h === 15 && m >= 0) ? ('after' as TradeTiming) : ('before' as TradeTiming);
    }
    return 'before' as TradeTiming;
  };

  const detectType = (line: string) => {
    const compact = line.replace(/\s+/g, '');
    if (/卖出|赎回|转出|转换\(转出\)/.test(compact)) return 'reduce';
    if (/买入|申购|定投|转入|转换\(转入\)/.test(compact)) return 'add';
    return null;
  };

  const isCanceled = (line: string) => {
    const compact = line.replace(/\s+/g, '');
    return (
      /交易确认中?/.test(compact) ||
      /交易失败/.test(compact) ||
      /交易取消/.test(compact) ||
      /已撤单|撤单|已撤/.test(compact)
    );
  };

  const normalizeYear = (raw: string) => {
    let year = Number(raw);
    if (!Number.isFinite(year)) return null;
    if (raw.length === 5) {
      const candidates: number[] = [];
      for (let i = 0; i < raw.length; i += 1) {
        const candidateStr = `${raw.slice(0, i)}${raw.slice(i + 1)}`;
        if (!/^\d{4}$/.test(candidateStr)) continue;
        const candidate = Number(candidateStr);
        if (candidate >= 2000 && candidate <= currentYear + 1) {
          candidates.push(candidate);
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => Math.abs(a - currentYear) - Math.abs(b - currentYear));
        year = candidates[0];
      }
    }
    if (raw.length === 2) year = 2000 + year;
    if (raw.length === 3) year = 2000 + (year % 100);
    if (year < 2000 || year > currentYear + 1) {
      year = currentYear;
    } else if (year < currentYear - 3) {
      year = currentYear;
    }
    return year;
  };

  const parseAmountWithUnit = (line: string) => {
    const unitMatch = line.match(/([0-9][0-9,\\.]*[0-9])\s*([元份])/);
    if (!unitMatch) return null;
    const unit = unitMatch[2];
    const rawNumber = unitMatch[1];
    const normalizeNumber = (value: string) => {
      let cleaned = value.replace(/[^\d.,]/g, '');
      if (!cleaned) return null;
      const dotCount = (cleaned.match(/\./g) || []).length;
      if (dotCount > 1) {
        const lastDot = cleaned.lastIndexOf('.');
        const integerPart = cleaned.slice(0, lastDot).replace(/[.,]/g, '');
        const decimalPart = cleaned.slice(lastDot + 1).replace(/[.,]/g, '');
        cleaned = `${integerPart}.${decimalPart}`;
      } else {
        cleaned = cleaned.replace(/,/g, '');
      }
      const num = Number(cleaned);
      return Number.isFinite(num) ? num : null;
    };
    let value = normalizeNumber(rawNumber);
    if (!Number.isFinite(value)) return null;
    if (unit === '元' && value < 1000) {
      const tokens = line.split(' ');
      for (let i = 0; i < tokens.length; i += 1) {
        if (!tokens[i].includes(unit)) continue;
        const numberPart = tokens[i].replace(unit, '');
        if (!numberPart) continue;
        const prevToken = tokens[i - 1] || '';
        if (/^\d{1,2}$/.test(prevToken)) {
          const mergedValue = normalizeNumber(`${prevToken}${numberPart}`);
          if (mergedValue !== null && mergedValue > value) {
            value = mergedValue;
            break;
          }
        } else {
          const mergedValue = normalizeNumber(numberPart);
          if (mergedValue !== null && mergedValue > value) {
            value = mergedValue;
            break;
          }
        }
      }
    }
    return { value, unit };
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx];
    const line = normalizeLine(rawLine);
    if (isCanceled(line)) {
      if (lastAddedLineIndex !== null && idx - lastAddedLineIndex <= 1) {
        items.pop();
        lastAddedLineIndex = null;
      }
      pending = null;
      continue;
    }
    const type = detectType(line);
    if (type) {
      if (pending) {
        finalize(pending, idx);
      }
      pending = { type, raw: rawLine, amount: null, shares: null };
    }

    const amountInfo = parseAmountWithUnit(line);
    if (amountInfo) {
      const value = amountInfo.value;
      if (amountInfo.unit === '元') {
        if (!pending) pending = { type: 'add', raw: rawLine };
        pending.amount = value;
        pending.shares = pending.shares ?? null;
      } else {
        if (!pending) pending = { type: 'reduce', raw: rawLine };
        pending.shares = value;
        pending.amount = pending.amount ?? null;
      }
    }

    const dateMatch = line.match(
      /(\d{2,5})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2,3})?)/
    );
    if (dateMatch) {
      const year = normalizeYear(dateMatch[1]);
      const month = Number(dateMatch[2]);
      const day = Number(dateMatch[3]);
      if (!year || month < 1 || month > 12 || day < 1 || day > 31) continue;
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const time = dateMatch[4];
      if (!pending) pending = { type: 'add', raw: rawLine };
      pending.date = date;
      pending.time = time;
      pending.timing = parseTiming(time);
      finalize(pending, idx);
      pending = null;
    }
  }

  if (pending) finalize(pending, lines.length);
  return items;
}

export function detectFundFromText(text: string, candidates: FundCandidate[]) {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, '');
  const bracketMatch = normalized.match(/[（(](\d{6})[）)]/);
  const codes = normalized.match(/\d{6}/g) || [];
  const byCode = new Map(candidates.map((item) => [item.code, item]));
  if (bracketMatch && bracketMatch[1]) {
    const found = byCode.get(bracketMatch[1]);
    return found || { code: bracketMatch[1] };
  }
  for (const code of codes) {
    const found = byCode.get(code);
    if (found) return found;
  }
  if (codes.length) {
    return { code: codes[0] };
  }

  const normalizeName = (value: string) =>
    value.replace(/\s+/g, '').replace(/[()（）·•\-_]/g, '');

  const normalizedText = normalizeName(text);
  let best: FundCandidate | null = null;
  let bestScore = 0;
  candidates.forEach((candidate) => {
    if (!candidate.name) return;
    const name = normalizeName(candidate.name);
    if (!name) return;
    if (normalizedText.includes(name) && name.length > bestScore) {
      bestScore = name.length;
      best = candidate;
    }
  });

  return best;
}
