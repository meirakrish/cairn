# Eval corpus

Frozen inputs for `pnpm eval`. Don't edit them to make a question pass: the point is a fixed target, so scores stay comparable across retrieval changes.

| File                    | Source                                                                                                                   | Ingested as                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `constitution.txt`      | Project Gutenberg #5, the US Constitution (1787, public domain), text only                                               | a PDF built at run time (`constitution.pdf`), 50 lines per page                                   |
| `elements-of-style.txt` | Project Gutenberg #37134, William Strunk Jr., _The Elements of Style_ (1918, public domain), text only                   | text                                                                                              |
| `design.md`             | Cairn's `DESIGN.md` as of 2026-10-20                                                                                     | Markdown                                                                                          |
| `llm-kit.md`            | llm-kit's `README.md` as of v0.3.0                                                                                       | Markdown                                                                                          |
| `trails.csv`            | Synthetic (generated once, 2026-10-21): 120 trails, `;`-separated, one hand-edited row (T141)                            | CSV                                                                                               |
| `shop.json`             | Synthetic (generated once, 2026-10-21): a shop with 80 nested orders, one lost in transit                                | JSON                                                                                              |
| `trailhead.svg`         | Hand-written: a trail sign                                                                                               | a PNG rendered at run time (`trailhead.png`), read by the vision model                            |
| `minutes.svg`           | Hand-written: club minutes with a table and a signature                                                                  | a JPEG rendered at run time, rotated 0.6°, as the only page of a scanned PDF (`minutes-scan.pdf`) |
| `ridgeback-hut.html`    | Hand-written (2026-10-21): a club page with header, nav, `<main>` sections, a table, a code block, an aside and a footer | a web page (kind `web`), read from the file, not fetched                                          |

The Gutenberg files have the Project Gutenberg header, license and transcriber's notes removed; what remains is public-domain text.

The image and the scanned PDF are read by the vision model (`LLM_MODEL`) at ingest, so their chunks vary slightly between runs; their questions expect short, distinctive phrases.
