export const invoices = [
  {id: 'INV-1042', client: 'Northstar Studio', cents: 124950, currency: 'USD', date: '2026-09-03', status: 'Paid'},
  {id: 'INV-1043', client: 'Fieldwork Labs', cents: 68000, currency: 'USD', date: '2026-09-07', status: 'Pending'},
  {id: 'INV-1044', client: 'Orbit Design', cents: 217500, currency: 'USD', date: '2026-09-05', status: 'Paid'},
];

export function formatAmount(cents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function newestFirst(items) {
  return [...items].sort((a, b) => new Date(b.date) - new Date(a.date));
}

export function invoiceSummary(items) {
  const count = items.length;
  const totalCents = items.reduce((sum, item) => sum + item.cents, 0);
  const paidCents = items.reduce((sum, item) => item.status === 'Paid' ? sum + item.cents : sum, 0);
  return { count, totalCents, paidCents };
}

// New function to export invoices as CSV string
export function exportInvoicesCsv(items) {
  // CSV headers
  const headers = ['Invoice', 'Client', 'Issued', 'Amount', 'Currency', 'Status'];
  // Escape function for CSV fields
  const escapeCsv = (str) => {
    if (str == null) return '';
    str = String(str);
    if (/[,"\n\r]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const lines = [headers.join(',')];
  for (const inv of items) {
    const row = [
      escapeCsv(inv.id),
      escapeCsv(inv.client),
      escapeCsv(inv.date),
      // Amount as dollars, using cents / 100 without formatting to keep raw numeric value
      (inv.cents / 100).toFixed(2),
      escapeCsv(inv.currency),
      escapeCsv(inv.status),
    ];
    lines.push(row.join(','));
  }
  return lines.join('\n');
}
