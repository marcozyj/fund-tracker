let workerPromise: Promise<any> | null = null;
let progressListener: ((payload: { status: string; progress: number }) => void) | null = null;

function notifyProgress(payload: { status: string; progress: number }) {
  if (progressListener) progressListener(payload);
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
