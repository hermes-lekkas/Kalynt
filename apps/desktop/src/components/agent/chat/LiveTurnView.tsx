/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The model turn being streamed: reasoning, text as it's written, and tool
 * calls as the model composes them.
 */
import { Loader2 } from 'lucide-react'
import type { LiveTurn } from '../../../services/agent/runner'
import { Markdown } from './Markdown'
import { Reasoning } from './Transcript'

const FIELD = /"(path|command|pattern|query|url|from)"\s*:\s*"((?:[^"\\]|\\.)*)/

const VERB: Record<string, string> = {
    read_file: 'Reading', list_directory: 'Listing', find_files: 'Finding', search_code: 'Searching for',
    search_codebase: 'Looking up', edit_file: 'Editing', write_file: 'Writing', move_path: 'Moving', delete_path: 'Deleting',
    run_command: 'Preparing to run', web_search: 'Searching the web for', web_fetch: 'Reading', update_plan: 'Updating the plan',
    get_diagnostics: 'Checking', git_status: 'Checking git status', git_diff: 'Diffing'
}

/** "Editing src/app.ts" from a tool call whose arguments are still streaming. */
function describe(name: string, input: string): string {
    const field = FIELD.exec(input)
    let target = ''
    if (field) {
        try { target = JSON.parse(`"${field[2]}"`) } catch { target = field[2] }
    }
    const verb = VERB[name] ?? name.replace(/_/g, ' ')
    return target ? `${verb} ${target}` : verb
}

export function LiveTurnView({ turn, working }: { turn: LiveTurn | null; working: boolean }) {
    if (!turn) {
        return working ? <div className="agent-working"><Loader2 size={13} className="spin" aria-hidden /> Working</div> : null
    }
    const writing = turn.calls.find(c => c.name === 'write_file' || c.name === 'edit_file')
    const writtenChars = writing ? writing.input.length : 0
    return (
        <div className="agent-turn is-live" aria-live="polite">
            {turn.notice && <p className="agent-note"><span>{turn.notice}</span></p>}
            <Reasoning text={turn.reasoning} live={!turn.text && !turn.calls.length} />
            {turn.text && <div className="chat-msg chat-msg--agent is-streaming selectable"><Markdown text={turn.text} /></div>}
            {turn.calls.map(call => (
                <div key={call.id} className="tool-card is-composing">
                    <div className="tool-card__head">
                        <Loader2 size={13} className="spin" aria-hidden />
                        <span className="tool-card__title truncate">{describe(call.name, call.input)}</span>
                        {call === writing && writtenChars > 400 && <span className="tool-card__stat">{Math.round(writtenChars / 1024 * 10) / 10} KB</span>}
                    </div>
                </div>
            ))}
            {!turn.text && !turn.calls.length && !turn.reasoning && <div className="agent-working"><Loader2 size={13} className="spin" aria-hidden /> Thinking</div>}
        </div>
    )
}
