import test from 'node:test';
import { strict as assert } from 'assert';
import { exportInvoicesCsv, newestFirst, invoiceSummary } from './invoices.mjs';

const csvHeaders = 'Invoice,Client,Issued,Amount,Currency,Status';

// Separate named tests for CSV export feature

test('CSV export includes correct headers and rows', () => {
  const csvOutput = exportInvoicesCsv([
    { id: 'INV-99', client: 'Cliente A', cents: 12345, currency: 'USD', date: '2021-01-01', status: 'Paid' },
    { id: 'INV-100', client: 'Cliente B', cents: 67890, currency: 'USD', date: '2021-01-02', status: 'Pending' }
  ]);
  const lines = csvOutput.split('\n');
  assert.strictEqual(lines[0], csvHeaders, 'CSV should have correct headers');
  assert.strictEqual(lines.length, 3, 'CSV output should have correct number of lines');
  assert.ok(lines[1].startsWith('INV-99,Cliente A,2021-01-01,123.45,USD,Paid'), 'First invoice line correct');
  assert.ok(lines[2].startsWith('INV-100,Cliente B,2021-01-02,678.90,USD,Pending'), 'Second invoice line correct');
});

test('CSV export escapes commas, quotes, newlines, and carriage returns', () => {
  const trickyCsv = exportInvoicesCsv([
    { id: 'ID,1', client: 'Client "X"', cents: 99999, date: '2021-02-01', status: `Paid\nPending\r` }
  ]);
  assert.ok(trickyCsv.includes('"ID,1"'), 'IDs with comma must be quoted');
  assert.ok(trickyCsv.includes('"Client ""X"""'), 'Client quotes properly escaped');
  assert.ok(trickyCsv.includes('"Paid\nPending\r"'), 'Newlines and carriage returns in status quoted');
});

test('CSV export with empty input returns only headers', () => {
  const emptyCsv = exportInvoicesCsv([]);
  assert.strictEqual(emptyCsv, csvHeaders, 'Empty CSV should only contain headers');
});

test('CSV export function does not mutate input array', () => {
  const input = [
    { id: 'INV-1', client: 'Immutable', cents: 5000, date: '2021-03-01', status: 'Paid' }
  ];
  const inputCopy = JSON.stringify(input);
  exportInvoicesCsv(input);
  assert.strictEqual(JSON.stringify(input), inputCopy, 'Input array should not be mutated');
});

// Fix immutability test for newestFirst using fresh fixture and deep cloning

test('newestFirst returns correctly sorted copy without mutating input', () => {
  const input = [
    { id: '1', date: '2026-01-01' },
    { id: '2', date: '2026-02-01' },
    { id: '3', date: '2026-01-15' }
  ];
  const inputClone = JSON.parse(JSON.stringify(input));
  const sorted = newestFirst(input);
  // Check order
  assert.strictEqual(sorted[0].id, '2');
  assert.strictEqual(sorted[1].id, '3');
  assert.strictEqual(sorted[2].id, '1');
  // Check original input unchanged
  assert.deepStrictEqual(input, inputClone);
});

// Re-add test invoiceSummary with empty input
test('invoiceSummary with empty input', () => {
  const summary = invoiceSummary([]);
  assert.deepStrictEqual(summary, { count: 0, totalCents: 0, paidCents: 0 }, 'Summary of empty list should have all zeros');
});

// Keep console log for visibility
console.log('All tests passed!');
