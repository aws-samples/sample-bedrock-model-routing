#!/bin/bash
set -e

# Check for tectonic (cross-platform LaTeX engine)
if command -v tectonic &>/dev/null; then
  tectonic multiplexer-spec.tex
  echo "done: multiplexer-spec.pdf"
  exit 0
fi

# Fallback to pdflatex
if command -v pdflatex &>/dev/null; then
  pdflatex -interaction=nonstopmode multiplexer-spec.tex
  echo "done: multiplexer-spec.pdf"
  exit 0
fi

echo "error: neither tectonic nor pdflatex found"
echo "install with: brew install tectonic  (macOS)"
exit 1
