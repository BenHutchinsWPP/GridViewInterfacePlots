# WASM CSV Parser

`block.c` parses whole GridView interface CSV data rows into a fixed slab:

```text
512 interfaces x 4096 hours
```

The JavaScript ingest path reads the title, preamble, and line-5 header, then
uses trimmed header names to map slab planes into each case cube.

## Build

```bash
./build.sh
```

The output is `parser/block.wasm`. Commit it with any parser change.

## Rules

- Keep buffers sized to a block, not a whole case.
- Derive hour index from each row's own `Date` and `Hour` fields.
- Read `TOU` from the file; do not derive it.
- Refuse unreadable rows or exports wider than 512 interfaces.
- Count Feb 29 separately; dropping it is expected.
