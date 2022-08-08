// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import monoWasmThreads from "consts:monoWasmThreads";
import type {
    DiagnosticOptions,
    EventPipeSessionOptions,
} from "../types";
import { is_nullish } from "../types";
import type { VoidPtr } from "../types/emscripten";
import { getController, startDiagnosticServer } from "./browser/controller";
import * as memory from "../memory";

export type { ProviderConfiguration } from "./browser/session-options-builder";
import {
    eventLevel, EventLevel,
    SessionOptionsBuilder,
} from "./browser/session-options-builder";
import { EventPipeSession, makeEventPipeSession } from "./browser/file-session";

export interface Diagnostics {
    eventLevel: EventLevel;
    SessionOptionsBuilder: typeof SessionOptionsBuilder;

    createEventPipeSession(options?: EventPipeSessionOptions): EventPipeSession | null;
    getStartupSessions(): (EventPipeSession | null)[];
}

let startup_session_configs: EventPipeSessionOptions[] = [];
let startup_sessions: (EventPipeSession | null)[] | null = null;

// called from C on the main thread
export function mono_wasm_event_pipe_early_startup_callback(): void {
    if (monoWasmThreads) {
        if (startup_session_configs === null || startup_session_configs.length == 0) {
            return;
        }
        console.debug("MONO_WASM: diagnostics: setting startup sessions based on startup session configs", startup_session_configs);
        startup_sessions = startup_session_configs.map(config => createAndStartEventPipeSession(config));
        startup_session_configs = [];
    }
}


function createAndStartEventPipeSession(options: (EventPipeSessionOptions)): EventPipeSession | null {
    const session = makeEventPipeSession(options);
    if (session === null) {
        return null;
    }
    session.start();

    return session;
}

function getDiagnostics(): Diagnostics {
    if (monoWasmThreads) {
        return {
            /// An enumeration of the level (higher value means more detail):
            /// LogAlways: 0,
            /// Critical: 1,
            /// Error: 2,
            /// Warning: 3,
            /// Informational: 4,
            /// Verbose: 5,
            eventLevel: eventLevel,
            /// A builder for creating an EventPipeSessionOptions instance.
            SessionOptionsBuilder: SessionOptionsBuilder,
            /// Creates a new EventPipe session that will collect trace events from the runtime and managed libraries.
            /// Use the options to control the kinds of events to be collected.
            /// Multiple sessions may be created and started at the same time.
            createEventPipeSession: makeEventPipeSession,
            getStartupSessions(): (EventPipeSession | null)[] {
                return Array.from(startup_sessions || []);
            },
        };
    } else {
        return undefined as unknown as Diagnostics;
    }
}

/// APIs for working with .NET diagnostics from JavaScript.
export const diagnostics: Diagnostics = getDiagnostics();

// Initialization flow
///   * The runtime calls configure_diagnostics with options from MonoConfig
///   * We start the diagnostic server which connects to the host and waits for some configurations (an IPC CollectTracing command)
///   * The host sends us the configurations and we push them onto the startup_session_configs array and let the startup resume
///   * The runtime calls mono_wasm_initA_diagnostics with any options from MonoConfig
///   * The runtime C layer calls mono_wasm_event_pipe_early_startup_callback during startup once native EventPipe code is initialized
///   * We start all the sessiosn in startup_session_configs and allow them to start streaming
///   * The IPC sessions first send an IPC message with the session ID and then they start streaming
////  * If the diagnostic server gets more commands it will send us a message through the serverController and we will start additional sessions

let suspendOnStartup = false;
let diagnosticsServerEnabled = false;

let diagnosticsInitialized = false;

export async function mono_wasm_init_diagnostics(opts: "env" | DiagnosticOptions): Promise<void> {
    if (diagnosticsInitialized)
        return;
    if (!monoWasmThreads) {
        console.warn("MONO_WASM: ignoring diagnostics options because this runtime does not support diagnostics", opts);
        return;
    } else {
        let options: DiagnosticOptions | null;
        if (opts === "env") {
            options = diagnostic_options_from_environment();
            if (!options)
                return;
        } else {
            options = opts;
        }
        diagnosticsInitialized = true;
        if (!is_nullish(options?.server)) {
            if (options.server.connectUrl === undefined || typeof (options.server.connectUrl) !== "string") {
                throw new Error("server.connectUrl must be a string");
            }
            const url = options.server.connectUrl;
            const suspend = boolsyOption(options.server.suspend);
            const controller = await startDiagnosticServer(url);
            if (controller) {
                diagnosticsServerEnabled = true;
                if (suspend) {
                    suspendOnStartup = true;
                }
            }
        }
        const sessions = options?.sessions ?? [];
        startup_session_configs.push(...sessions);
    }
}

function boolsyOption(x: string | boolean): boolean {
    if (x === true || x === false)
        return x;
    if (typeof x === "string") {
        if (x === "true")
            return true;
        if (x === "false")
            return false;
    }
    throw new Error(`invalid option: "${x}", should be true, false, or "true" or "false"`);
}

/// Parse environment variables for diagnostics configuration
///
/// The environment variables are:
///  * DOTNET_DiagnosticPorts
///
function diagnostic_options_from_environment(): DiagnosticOptions | null {
    const val = memory.getEnv("DOTNET_DiagnosticPorts");
    if (is_nullish(val))
        return null;
    // TODO: consider also parsing the DOTNET_EnableEventPipe and DOTNET_EventPipeOutputPath, DOTNET_EvnetPipeConfig variables
    // to configure the startup sessions that will dump output to the VFS.
    return diagnostic_options_from_ports_spec(val);
}

/// Parse a DOTNET_DiagnosticPorts string and return a DiagnosticOptions object.
/// See https://docs.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port#configure-additional-diagnostic-ports
function diagnostic_options_from_ports_spec(val: string): DiagnosticOptions | null {
    if (val === "")
        return null;
    const ports = val.split(";");
    if (ports.length === 0)
        return null;
    if (ports.length !== 1) {
        console.warn("MONO_WASM: multiple diagnostic ports specified, only the last one will be used");
    }
    const portSpec = ports[ports.length - 1];
    const components = portSpec.split(",");
    if (components.length < 1 || components.length > 3) {
        console.warn("MONO_WASM: invalid diagnostic port specification, should be of the form <port>[,<connect>],[<nosuspend|suspend>]");
        return null;
    }
    const uri: string = components[0];
    let connect = true;
    let suspend = true;
    // the C Diagnostic Server goes through these parts in reverse, do the same here.
    for (let i = components.length - 1; i >= 1; i--) {
        const component = components[i];
        switch (component.toLowerCase()) {
            case "nosuspend":
                suspend = false;
                break;
            case "suspend":
                suspend = true;
                break;
            case "listen":
                connect = false;
                break;
            case "connect":
                connect = true;
                break;
            default:
                console.warn(`MONO_WASM: invalid diagnostic port specification component: ${component}`);
                break;
        }
    }
    if (!connect) {
        console.warn("MONO_WASM: this runtime does not support listening on a diagnostic port; no diagnostic server started");
        return null;
    }
    return {
        server: {
            connectUrl: uri,
            suspend: suspend,
        }
    };

}

export function mono_wasm_diagnostic_server_on_runtime_server_init(out_options: VoidPtr): void {
    if (diagnosticsServerEnabled) {
        /* called on the main thread when the runtime is sufficiently initialized */
        const controller = getController();
        controller.postServerAttachToRuntime();
        // FIXME: is this really the best place to do this?
        memory.setI32(out_options, suspendOnStartup ? 1 : 0);
    }
}

export default diagnostics;
