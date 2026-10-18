/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
/**
 * VS Code compatible debug configuration types
 * Based on VS Code launch.json schema
 */

export type DebugType =
  | 'node'
  | 'pwa-node'
  | 'node-terminal'
  | 'python'
  | 'debugpy'
  | 'cppdbg'
  | 'lldb'
  | 'gdb'
  | 'go'
  | 'delve'
  | 'rust-lldb'
  | 'codelldb'
  | 'coreclr'
  | 'java'
  | 'php'
  | 'ruby';

export type DebugRequest = 'launch' | 'attach';

export interface DebugConfiguration {
  type: DebugType;
  request: DebugRequest;
  name: string;
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  envFile?: string;
  console?: 'internalConsole' | 'integratedTerminal' | 'externalTerminal';
  stopOnEntry?: boolean;
  preLaunchTask?: string;
  postDebugTask?: string;
  internalConsoleOptions?: 'neverOpen' | 'openOnSessionStart' | 'openOnFirstSessionStart';

  // Node.js specific
  runtimeExecutable?: string;
  runtimeArgs?: string[];
  skipFiles?: string[];
  sourceMaps?: boolean;
  outFiles?: string[];

  // Python specific
  pythonPath?: string;
  python?: string;
  module?: string;
  django?: boolean;
  jinja?: boolean;

  // C/C++/Rust specific
  MIMode?: 'gdb' | 'lldb';
  miDebuggerPath?: string;
  setupCommands?: DebugCommand[];

  // Go specific
  mode?: 'debug' | 'test' | 'exec' | 'auto';
  remotePath?: string;
  dlvToolPath?: string;

  // Attach specific
  processId?: string | number;
  port?: number;
  address?: string;
  host?: string;
}

export interface DebugCommand {
  text: string;
  description?: string;
  ignoreFailures?: boolean;
}

export interface LaunchConfiguration {
  version: '0.2.0';
  configurations: DebugConfiguration[];
  compounds?: CompoundDebugConfiguration[];
}

export interface CompoundDebugConfiguration {
  name: string;
  configurations: string[];
  stopAll?: boolean;
  preLaunchTask?: string;
}

// Debug Adapter Protocol (DAP) types
export interface DAPMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
}

export interface DAPRequest extends DAPMessage {
  type: 'request';
  command: string;
  arguments?: any;
}

export interface DAPResponse extends DAPMessage {
  type: 'response';
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: any;
}

export interface DAPEvent extends DAPMessage {
  type: 'event';
  event: string;
  body?: any;
}

// Breakpoint types
export interface Breakpoint {
  id: string;
  file: string;
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  enabled: boolean;
  verified?: boolean;
}

export interface SourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

// Debug session state
export interface DebugSession {
  id: string;
  configuration: DebugConfiguration;
  state: DebugSessionState;
  threadId?: number;
  breakpoints: Map<string, Breakpoint[]>;
  variables: Variable[];
  callStack: StackFrame[];
}

export type DebugSessionState =
  | 'initializing'
  | 'running'
  | 'stopped'
  | 'terminated'
  | 'error';

export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
}

export interface StackFrame {
  id: number;
  name: string;
  source?: Source;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface Source {
  name?: string;
  path?: string;
  sourceReference?: number;
  origin?: string;
}

export interface Scope {
  name: string;
  variablesReference: number;
  expensive: boolean;
  source?: Source;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

// Debug adapter capabilities
export interface DebugAdapterDescriptor {
  type: DebugType;
  label: string;
  languages: string[];
  configurationSnippets: DebugConfigurationSnippet[];
}

export interface DebugConfigurationSnippet {
  label: string;
  description?: string;
  body: Partial<DebugConfiguration>;
}
