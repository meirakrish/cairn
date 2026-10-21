export type Row = Record<string, string | number>;

export interface TableQuestion {
  id: string;
  style:
    | 'count'
    | 'sum'
    | 'average'
    | 'extreme'
    | 'group'
    | 'top'
    | 'listing'
    | 'date'
    | 'lookup'
    | 'passages';
  question: string;
  /** The table the question needs; undefined means passages should answer it. */
  table?: 'trails.csv' | 'orders.jsonl';
  /** A question the router may take either way (one row's value): only the answer is graded. */
  either?: boolean;
  /** The values the result and the answer must hold, worked out from the table's own rows. */
  truth?: (rows: Row[]) => Array<string | number>;
  /** A listing: the result holds exactly `truth`'s rows. */
  exact?: boolean;
}

const sum = (rows: Row[], column: string) => rows.reduce((n, r) => n + Number(r[column] ?? 0), 0);
const where = (rows: Row[], column: string, value: string | number) =>
  rows.filter((r) => r[column] === value);
const by = (rows: Row[], column: string) => {
  const groups = new Map<string, Row[]>();
  for (const r of rows)
    groups.set(String(r[column]), [...(groups.get(String(r[column])) ?? []), r]);
  return groups;
};
const best = (rows: Row[], score: (r: Row) => number) => {
  const top = Math.max(...rows.map(score));
  return rows.filter((r) => score(r) === top);
};

export const TABLE_QUESTIONS: TableQuestion[] = [
  {
    id: 'trails-count-region',
    style: 'count',
    question: 'How many trails are in the Lakes region?',
    table: 'trails.csv',
    truth: (rows) => [where(rows, 'region', 'Lakes').length],
  },
  {
    id: 'trails-count-distinct',
    style: 'count',
    question: 'How many different regions do the trails cover?',
    table: 'trails.csv',
    truth: (rows) => [by(rows, 'region').size],
  },
  {
    id: 'trails-total-length',
    style: 'sum',
    question: 'What is the total length of all trails, in km?',
    table: 'trails.csv',
    truth: (rows) => [sum(rows, 'length_km')],
  },
  {
    id: 'trails-sum-filter',
    style: 'sum',
    question: 'How many cairns are there on the hard trails in total?',
    table: 'trails.csv',
    truth: (rows) => [sum(where(rows, 'difficulty', 'hard'), 'cairns')],
  },
  {
    id: 'trails-avg-length',
    style: 'average',
    question: 'What is the average length of the moderate trails?',
    table: 'trails.csv',
    truth: (rows) => {
      const moderate = where(rows, 'difficulty', 'moderate');
      return [sum(moderate, 'length_km') / moderate.length];
    },
  },
  {
    id: 'trails-most-cairns',
    style: 'extreme',
    question: 'Which trail has the most cairns?',
    table: 'trails.csv',
    truth: (rows) => best(rows, (r) => Number(r.cairns)).map((r) => String(r.name)),
  },
  {
    id: 'trails-longest-coast',
    style: 'extreme',
    question: 'What is the longest trail on the Coast, and how long is it?',
    table: 'trails.csv',
    truth: (rows) =>
      best(where(rows, 'region', 'Coast'), (r) => Number(r.length_km)).flatMap((r) => [
        String(r.name),
        Number(r.length_km),
      ]),
  },
  {
    id: 'trails-per-difficulty',
    style: 'group',
    question: 'How many trails are there for each difficulty?',
    table: 'trails.csv',
    truth: (rows) => [...by(rows, 'difficulty')].flatMap(([d, g]) => [d, g.length]),
  },
  {
    id: 'trails-top-regions',
    style: 'top',
    question: 'Which three regions have the greatest total trail length?',
    table: 'trails.csv',
    truth: (rows) =>
      [...by(rows, 'region')]
        .map(([region, g]) => ({ region, total: sum(g, 'length_km') }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 3)
        .map((r) => r.region),
  },
  {
    id: 'trails-list-easy-long',
    style: 'listing',
    question: 'List the easy trails that are longer than 20 km.',
    table: 'trails.csv',
    truth: (rows) =>
      where(rows, 'difficulty', 'easy')
        .filter((r) => Number(r.length_km) > 20)
        .map((r) => String(r.name)),
    exact: true,
  },
  {
    id: 'trails-inspected-after',
    style: 'date',
    question: 'How many trails were last inspected after 30 June 2026?',
    table: 'trails.csv',
    truth: (rows) => [rows.filter((r) => String(r.last_inspected) > '2026-06-30').length],
  },
  {
    id: 'trails-first-inspection',
    style: 'date',
    question: 'When was the earliest inspection date?',
    table: 'trails.csv',
    truth: (rows) => [rows.map((r) => String(r.last_inspected)).sort()[0]!],
  },
  {
    id: 'trails-lookup',
    style: 'lookup',
    question: 'How long is Fox Hollow 1?',
    table: 'trails.csv',
    either: true,
    truth: (rows) => [Number(rows.find((r) => r.name === 'Fox Hollow 1')!.length_km)],
  },
  {
    id: 'orders-count-status',
    style: 'count',
    question: 'How many orders are still pending?',
    table: 'orders.jsonl',
    truth: (rows) => [where(rows, 'status', 'pending').length],
  },
  {
    id: 'orders-revenue-shipped',
    style: 'sum',
    question: 'What is the total value of the shipped orders?',
    table: 'orders.jsonl',
    truth: (rows) => [sum(where(rows, 'status', 'shipped'), 'total')],
  },
  {
    id: 'orders-top-customer',
    style: 'top',
    question: 'Which customer has spent the most across all orders?',
    table: 'orders.jsonl',
    truth: (rows) => {
      const totals = [...by(rows, 'customer')].map(([c, g]) => ({ c, total: sum(g, 'total') }));
      const top = Math.max(...totals.map((t) => t.total));
      return totals.filter((t) => t.total === top).map((t) => t.c);
    },
  },
  {
    id: 'orders-per-country',
    style: 'group',
    question: 'How many orders came from each country?',
    table: 'orders.jsonl',
    truth: (rows) => [...by(rows, 'country')].flatMap(([c, g]) => [c, g.length]),
  },
  {
    id: 'orders-best-product',
    style: 'top',
    question: 'Which product sold the most units?',
    table: 'orders.jsonl',
    truth: (rows) => {
      const totals = [...by(rows, 'product')].map(([p, g]) => ({ p, units: sum(g, 'qty') }));
      const top = Math.max(...totals.map((t) => t.units));
      return totals.filter((t) => t.units === top).map((t) => t.p);
    },
  },
  {
    id: 'orders-from-march',
    style: 'date',
    question: 'How many orders were placed in March 2026?',
    table: 'orders.jsonl',
    truth: (rows) => [rows.filter((r) => String(r.ordered).startsWith('2026-03')).length],
  },
  {
    id: 'passages-explain',
    style: 'passages',
    question: 'What is a cairn, and why do hikers build them?',
  },
  {
    id: 'passages-who',
    style: 'passages',
    question: 'Who was Ada Lovelace?',
  },
  {
    id: 'passages-howto',
    style: 'passages',
    question: 'How should I pack a rucksack for a day hike?',
  },
];
