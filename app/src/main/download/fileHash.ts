import { Worker } from 'node:worker_threads'

// The SHA-256 of a finished file (ADR-0081), worked out in a worker thread so a large file doesn't
// hold up the main process: it reads the file in 1 MiB pieces and hashes them as they come. The
// worker's code is inline, so there is no second file for the build to bundle.

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const { createReadStream } = require('node:fs')
const { createHash } = require('node:crypto')
const hash = createHash('sha256')
let result = { error: 'The file could not be read' }
// Answered once the file is closed: the worker is ended on the answer, and a descriptor still
// open then would stay open in the app for good (descriptors belong to the process).
createReadStream(workerData, { highWaterMark: 1024 * 1024 })
  .on('data', (chunk) => hash.update(chunk))
  .on('error', (error) => { result = { error: String(error && error.message) } })
  .on('end', () => { result = { hex: hash.digest('hex') } })
  .on('close', () => parentPort.postMessage(result))
`

/** The file's SHA-256, as lowercase hex. */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: path })
    worker.once('message', (message: { hex?: string; error?: string }) => {
      void worker.terminate()
      if (message.hex) resolve(message.hex)
      else reject(new Error(message.error ?? 'The file could not be read'))
    })
    worker.once('error', reject)
  })
}
