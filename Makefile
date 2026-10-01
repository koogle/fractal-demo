.PHONY: build serve

build:
	cargo build --manifest-path rust/wasm/Cargo.toml --target wasm32-unknown-unknown --release
	cp rust/wasm/target/wasm32-unknown-unknown/release/fractal_demo_wasm.wasm web/fractal.wasm

serve: build
	python3 -m http.server 5173 --bind 127.0.0.1 --directory web

.PHONY: test
test:
	node --test tests/*.test.mjs
	node --check web/src.js
