import { createInterface } from 'node:readline';
import { handle } from './engine.mjs';

// One persistent process, serial bounded messages. stdout is protocol only.
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    if (Buffer.byteLength(line) > 128 * 1024) throw new Error('DBC request exceeds size limit');
    const result = await handle(JSON.parse(line));
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message ?? 'DBC quote failed' })}\n`);
  }
}
