let workerPromise: Promise<any> | null = null;
let progressListener: ((payload: { status: string; progress: number }) => void) | null = null;

function notifyProgress(payload: { status: string; progress: number }) {
  if (progressListener) progressListener(payload);
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal, cache: 'no-store' });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function preflightResource(url: string) {
  if (!url) return false;
  try {
    const head = await fetchWithTimeout(url, { method: 'HEAD' }, 8000);
    if (head.ok) return true;
    if (head.status === 405) {
      const range = await fetchWithTimeout(
        url,
        { method: 'GET', headers: { Range: 'bytes=0-0' } },
        8000
      );
      return range.ok;
    }
    return false;
  } catch {
    return false;
  }
}

function resolveBasePrefix() {
  if (typeof window === 'undefined') {
    return '';
  }
  const data = (window as any).__NEXT_DATA__ || {};
  const assetPrefix = typeof data.assetPrefix === 'string' ? data.assetPrefix : '';
  const origin = window.location.origin;
  if (!assetPrefix) return origin;
  if (/^https?:\/\//.test(assetPrefix)) return assetPrefix.replace(/\/$/, '');
  return `${origin}${assetPrefix.replace(/\/$/, '')}`;
}

function resolveOcrPaths() {
  const prefix = resolveBasePrefix();
  if (!prefix) {
    return {
      workerPath: '',
      corePath: '',
      langPath: ''
    };
  }
  return {
    workerPath: `${prefix}/tesseract/worker.min.js`,
    corePath: `${prefix}/tesseract/tesseract-core.wasm.js`,
    langPath: `${prefix}/tessdata`
  };
}

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const Tesseract = await import('tesseract.js');
    const { workerPath, corePath, langPath } = resolveOcrPaths();
    const worker = await Tesseract.createWorker({
      workerPath,
      corePath,
      langPath,
      logger: (message: { status: string; progress: number }) => notifyProgress(message)
    });
    const withTimeout = async <T>(promise: Promise<T>, label: string, timeoutMs = 20000) => {
      let timer: any;
      const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      });
      const result = await Promise.race([promise, timeout]);
      clearTimeout(timer);
      return result as T;
    };
    await withTimeout(worker.loadLanguage('chi_sim'), 'loadLanguage');
    await withTimeout(worker.initialize('chi_sim'), 'initialize');
    return worker;
  })();
  return workerPromise;
}

export async function recognizeImage(
  file: File,
  onProgress?: (payload: { status: string; progress: number }) => void
) {
  try {
    progressListener = onProgress ?? null;
    const { workerPath, corePath, langPath } = resolveOcrPaths();
    notifyProgress({ status: '加载OCR资源', progress: 0 });
    const [workerOk, coreOk, langOk] = await Promise.all([
      preflightResource(workerPath),
      preflightResource(corePath),
      preflightResource(`${langPath}/chi_sim.traineddata.gz`)
    ]);
    if (!workerOk || !coreOk || !langOk) {
      throw new Error('OCR资源加载失败');
    }

    notifyProgress({ status: '初始化OCR', progress: 0 });
    const worker = await getWorker();
    const timeoutMs = 20000;
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('OCR timeout')), timeoutMs);
    });
    const result = (await Promise.race([worker.recognize(file), timeout])) as any;
    return result?.data?.text || '';
  } catch (error) {
    workerPromise = null;
    throw error;
  } finally {
    progressListener = null;
  }
}
