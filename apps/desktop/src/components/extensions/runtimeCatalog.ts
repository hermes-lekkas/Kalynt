/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Language runtimes Kalynt can detect and install so the editor can run code.
 */

export interface RuntimeEntry {
    id: string
    name: string
    description: string
    downloadUrl: string
    /** Files in this language can be run from the editor. */
    runsCode: boolean
    /** Kalynt can download and install it itself. */
    /** Always available, nothing to install. */
    builtIn?: boolean
}

export const RUNTIME_CATALOG: RuntimeEntry[] = [
    { id: 'node', name: 'Node.js', description: 'JavaScript & TypeScript runtime environment', downloadUrl: 'https://nodejs.org/en/download/', runsCode: true },
    { id: 'python', name: 'Python', description: 'Python 3 runtime for scripting and data science', downloadUrl: 'https://www.python.org/downloads/', runsCode: true },
    { id: 'rust', name: 'Rust', description: 'Systems programming language with cargo toolchain', downloadUrl: 'https://www.rust-lang.org/tools/install', runsCode: true },
    { id: 'go', name: 'Go', description: 'Fast, statically typed compiled language', downloadUrl: 'https://go.dev/dl/', runsCode: true },
    { id: 'java', name: 'Java (JDK)', description: 'Java Development Kit for Java applications', downloadUrl: 'https://www.oracle.com/java/technologies/downloads/', runsCode: true },
    { id: 'dotnet', name: '.NET SDK', description: 'C# and F# development platform', downloadUrl: 'https://dotnet.microsoft.com/download', runsCode: true },
    { id: 'ruby', name: 'Ruby', description: 'Dynamic, object-oriented scripting language', downloadUrl: 'https://www.ruby-lang.org/en/downloads/', runsCode: true },
    { id: 'php', name: 'PHP', description: 'Server-side scripting language', downloadUrl: 'https://www.php.net/downloads', runsCode: true },
    { id: 'gcc', name: 'C/C++ (GCC)', description: 'C and C++ compiler toolchain', downloadUrl: 'https://gcc.gnu.org/install/', runsCode: true },
    { id: 'kotlin', name: 'Kotlin', description: 'Modern JVM language for Android and more', downloadUrl: 'https://kotlinlang.org/docs/command-line.html', runsCode: true },
    { id: 'swift', name: 'Swift', description: "Apple's programming language", downloadUrl: 'https://www.swift.org/download/', runsCode: true },
    { id: 'scala', name: 'Scala', description: 'Functional programming on the JVM', downloadUrl: 'https://www.scala-lang.org/download/', runsCode: true },
    { id: 'perl', name: 'Perl', description: 'Highly capable text processing language', downloadUrl: 'https://www.perl.org/get.html', runsCode: true },
    { id: 'lua', name: 'Lua', description: 'Lightweight scripting language', downloadUrl: 'https://www.lua.org/download.html', runsCode: true },
    { id: 'haskell', name: 'Haskell', description: 'Pure functional programming language', downloadUrl: 'https://www.haskell.org/downloads/', runsCode: true },
    { id: 'elixir', name: 'Elixir', description: 'Functional language for scalable applications', downloadUrl: 'https://elixir-lang.org/install.html', runsCode: true },
    { id: 'r', name: 'R', description: 'Statistical computing and graphics', downloadUrl: 'https://cran.r-project.org/', runsCode: true },
    { id: 'julia', name: 'Julia', description: 'High-performance scientific computing', downloadUrl: 'https://julialang.org/downloads/', runsCode: true },
    { id: 'dart', name: 'Dart', description: 'Language for Flutter and web apps', downloadUrl: 'https://dart.dev/get-dart', runsCode: true },
    { id: 'zig', name: 'Zig', description: 'Modern systems programming language', downloadUrl: 'https://ziglang.org/download/', runsCode: true },
    { id: 'clojure', name: 'Clojure', description: 'Lisp dialect for the JVM', downloadUrl: 'https://clojure.org/guides/install_clojure', runsCode: true },
    { id: 'deno', name: 'Deno', description: 'Secure TypeScript/JavaScript runtime', downloadUrl: 'https://deno.land/manual/getting_started/installation', runsCode: true },
    { id: 'bun', name: 'Bun', description: 'Fast all-in-one JavaScript runtime', downloadUrl: 'https://bun.sh/docs/installation', runsCode: true },
    { id: 'nasm', name: 'NASM', description: 'Netwide Assembler for x86/x64', downloadUrl: 'https://www.nasm.us/pub/nasm/releasebuilds/', runsCode: false },
    { id: 'sass', name: 'Sass', description: 'CSS preprocessor with superpowers', downloadUrl: 'https://sass-lang.com/install', runsCode: false },
    { id: 'emscripten', name: 'Emscripten', description: 'C/C++ to WebAssembly compiler', downloadUrl: 'https://emscripten.org/docs/getting_started/downloads.html', runsCode: false },
    { id: 'wabt', name: 'WebAssembly Tools', description: 'WebAssembly Binary Toolkit', downloadUrl: 'https://github.com/WebAssembly/wabt/releases', runsCode: false },
    { id: 'groovy', name: 'Groovy', description: 'Dynamic language for the JVM', downloadUrl: 'https://groovy.apache.org/download.html', runsCode: true },
    { id: 'ocaml', name: 'OCaml', description: 'Functional programming with strong types', downloadUrl: 'https://ocaml.org/install', runsCode: true },
    { id: 'erlang', name: 'Erlang', description: 'Concurrent and fault-tolerant systems', downloadUrl: 'https://www.erlang.org/downloads', runsCode: true },
    { id: 'fsharp', name: 'F#', description: 'Functional-first .NET language', downloadUrl: 'https://fsharp.org/use/windows/', runsCode: true },
    { id: 'v', name: 'V', description: 'Simple, fast, safe compiled language', downloadUrl: 'https://github.com/vlang/v#installing-v-from-source', runsCode: true },
    { id: 'nim', name: 'Nim', description: 'Efficient, expressive, elegant language', downloadUrl: 'https://nim-lang.org/install.html', runsCode: true },
    { id: 'html', name: 'HTML', description: 'HyperText Markup Language for web pages', downloadUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTML', runsCode: true, builtIn: true }
]
