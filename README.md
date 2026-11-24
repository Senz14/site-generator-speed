# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Senz14/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Senz14/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free drop-in replacement for make.fun's makefun-site 1.0.0. `solve.js` exports `run(input)`, which returns exactly makefun-site's answer — the output tree of every page's index.html, the index and tag pages, build-report.txt and each static file — on every input, including every refused front matter, draft, broken link and shadowed static file. It is faster because templates are compiled once per case into plain JavaScript functions (includes inlined at compile time, scope lookups resolved statically), Markdown is rendered in a single pass without token objects, front matter is parsed by scanning indexes instead of splitting and re-joining the whole body, and slugify results are memoized. `main.ts` is the harness driver: it reads the cases from `/input/cases.json`, answers each one alone with `run`, and writes `/output/answers.json`.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=jkmc4mts&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
