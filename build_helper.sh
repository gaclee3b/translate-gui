#!/bin/bash
# Compile the Swift translation helper binary (macOS only).
# Run once before first use, or after modifying translate_helper.swift.
cd "$(dirname "$0")"
swiftc -O -parse-as-library translate_helper.swift -o translate_helper
echo "translate_helper compiled successfully."
