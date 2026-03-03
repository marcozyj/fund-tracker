let workerPromise: Promise<any> | null = null;

function resolveOcrPaths() {
  if (typeof window === 'undefined') {
    return {
      workerPath: '',
      corePath: '',
      langPath: ''
    };
  }
  const base = window.location.href;
  return {
    workerPath: new URL('tesseract/worker.min.js', base).toString(),
    corePath: new URL('tesseract/tesseract-core.wasm.js', base).toString(),
    langPath: new URL('tessdata', base).toString()
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
      langPath
    });
    await worker.loadLanguage('chi_sim');
    await worker.initialize('chi_sim');
    return worker;
  })();
  return workerPromise;
}

export async function recognizeImage(file: File) {
  try {
    const worker = await getWorker();
    const result = await worker.recognize(file);
    return result?.data?.text || '';
  } catch (error) {
    workerPromise = null;
    throw error;
  }
}

