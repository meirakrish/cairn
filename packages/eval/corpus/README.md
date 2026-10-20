# Eval corpus

Frozen inputs for `pnpm eval`. Don't edit them to make a question pass: the point is a fixed target, so scores stay comparable across retrieval changes.

| File                    | Source                                                                                                 | Ingested as                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `constitution.txt`      | Project Gutenberg #5, the US Constitution (1787, public domain), text only                             | a PDF built at run time (`constitution.pdf`), 50 lines per page |
| `elements-of-style.txt` | Project Gutenberg #37134, William Strunk Jr., _The Elements of Style_ (1918, public domain), text only | text                                                            |
| `design.md`             | Cairn's `DESIGN.md` as of 2026-10-20                                                                   | Markdown                                                        |
| `llm-kit.md`            | llm-kit's `README.md` as of v0.3.0                                                                     | Markdown                                                        |

The Gutenberg files have the Project Gutenberg header, license and transcriber's notes removed; what remains is public-domain text.
