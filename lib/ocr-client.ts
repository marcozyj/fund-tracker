let workerPromise: Promise<any> | null = null;
let workerInstance: any | null = null;

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const Tesseract = await import('tesseract.js');
    const worker = await Tesseract.createWorker('chi_sim');
    workerInstance = worker;
    return worker;
  })();
  return workerPromise;
}

export async function recognizeImage(
  file: File,
  onProgress?: (payload: { status: string; progress: number }) => void
) {
  try {
    onProgress?.({ status: '启动OCR', progress: 10 });
    const worker = await getWorker();
    const timeoutMs = 120000;
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('OCR timeout')), timeoutMs);
    });
    onProgress?.({ status: '识别中', progress: 60 });
    const result = (await Promise.race([worker.recognize(file), timeout])) as any;
    onProgress?.({ status: '识别完成', progress: 100 });
    return result?.data?.text || '';
  } catch (error) {
    workerPromise = null;
    workerInstance = null;
    throw error;
  }
}

export function resetOcrWorker() {
  if (workerInstance && typeof workerInstance.terminate === 'function') {
    try {
      workerInstance.terminate();
    } catch {
      // ignore
    }
  }
  workerPromise = null;
  workerInstance = null;
}
