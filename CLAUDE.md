# Agent Notes

- Read `README.md` first.
- This repo has a PUBLIC remote and deploys to GitHub Pages. Real study
  exports are confidential: never commit one, and never paste raw rows into
  code, docs, comments, commit messages, issues, or PRs. Test fixtures are
  synthetic and stay that way. The only CSVs that may be tracked are the
  ANONYMISED samples in `input/`; `.gitignore` carries the rest of the rule,
  including what to verify before a commit.
- Keep commit messages free of trailers such as `Co-Authored-By`,
  `Generated with`, or `Claude-Session`.
- Use `npm test` and `npm run build` before handing off code changes.
- `parser/block.wasm` is committed; rebuild it only when `parser/block.c`
  changes.
