import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TurnNodeEditor } from '../lib/editor.ts';
import { land, validateLanding } from '../lib/landing.ts';

/**
 * Regression tests through the real V4 relational validators.
 *
 * The invariant that made `session-e0ba7a2e` unloadable is not enforced by the
 * write path: a landing may append an `assistant/message` that cites a closed
 * turn, and only the next cold load rejects it. These tests therefore run the
 * plugin's own `land()` and hand the resulting log to the runtime's released V4
 * validators, so a future landing branch that writes an illegal event fails
 * here instead of corrupting a session file.
 */

const RUNTIME_PACKAGES = '/home/vilicvane/.dsh/runtime/node_modules/@deepseek-ai';

let validators: {
	assertReleasedV4Relationships: (artifact: any, knownEventTypes: Set<string>) => void;
	assertV4RowAdmission: (row: any) => void;
	restoreReleasedV4Artifact: (artifact: any, knownEventTypes: Set<string>) => any;
} | undefined;
let knownEventTypes: Set<string> | undefined;
let unavailable: string | undefined;

try {
	const format = await import(`${RUNTIME_PACKAGES}/dsh-session-format-v3-to-v4/lib/index.js`);
	const session = await import(`${RUNTIME_PACKAGES}/dsh-session/lib/index.js`);
	validators = format;
	knownEventTypes = session.KNOWN_SESSION_EVENT_TYPES;
} catch (error) {
	unavailable = `DSH runtime validators unavailable: ${(error as Error).message}`;
}

/**
 * Minimal session double matching the runtime append contract: an event records
 * `surfaceOp`/`sourceEventSeqs` at the top level, and a replacement splices the
 * current surface, so the landing path sees the same coordinates a real handle
 * would enforce.
 */
function fixtureSession(): any {
	const events: any[] = [];
	const surface = { nodes: [] as number[] };
	const append = (type: string, data: any, options?: { surfaceOp?: any; sourceEventSeqs?: number[] }): any => {
		const surfaceOp = options?.surfaceOp;
		const event: any = {
			seq: events.length,
			type,
			data,
			...(options?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }),
			...(surfaceOp === undefined ? {} : { surfaceOp }),
		};
		events.push(event);
		if (surfaceOp === 'append') {
			surface.nodes.push(event.seq);
		} else if (surfaceOp !== null && typeof surfaceOp === 'object' && surfaceOp.op === 'replace') {
			const first = surfaceOp.startSeq ?? surfaceOp.start;
			const last = surfaceOp.endSeq ?? surfaceOp.end;
			const firstIndex = surface.nodes.indexOf(first);
			const lastIndex = surface.nodes.indexOf(last);
			if (firstIndex < 0 || lastIndex < firstIndex) throw new Error('invalid replace surfaceOp');
			surface.nodes.splice(firstIndex, lastIndex - firstIndex + 1, event.seq);
		}
		return event;
	};
	return { events, snapshotEvents: () => events, eventAt: (seq: number) => events[seq], surface, header: {}, append };
}

function modelSource(): any {
	return { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' };
}

/** A completed turn whose rows satisfy native V4 message and source admission. */
function completedTurnSession(): any {
	const session = fixtureSession();
	session.append('turn/start', { turn: 1 });
	session.append('user/message', {
		id: 'u1',
		role: 'user',
		content: [{ type: 'text', text: 'original question' }],
		source: { kind: 'user-approval' },
	}, { surfaceOp: 'append' });
	session.append('step/start', { turn: 1, step: 1 });
	session.append('assistant/message', {
		turn: 1,
		step: 1,
		message: {
			id: 'a1',
			role: 'assistant',
			content: [{ type: 'text', text: 'original answer' }],
			source: modelSource(),
		},
	}, { surfaceOp: 'append' });
	session.append('step/end', { turn: 1, step: 1 });
	session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
	return session;
}

/**
 * A completed turn whose surface also carries a tool result. The `tool/call`
 * row closes the advertised call so `step/end`/`turn/end` may leave no pending
 * tool, which is a precondition for any landing at all.
 */
function toolTurnSession(): any {
	const session = fixtureSession();
	session.append('turn/start', { turn: 1 });
	session.append('user/message', {
		id: 'u1',
		role: 'user',
		content: [{ type: 'text', text: 'original question' }],
		source: { kind: 'user-approval' },
	}, { surfaceOp: 'append' });
	session.append('step/start', { turn: 1, step: 1 });
	session.append('assistant/message', {
		turn: 1,
		step: 1,
		message: {
			id: 'a1',
			role: 'assistant',
			content: [
				{ type: 'text', text: 'let me look' },
				{ type: 'tool-call', id: 'call-1', name: 'read_turn_nodes', arguments: '{"ids":["n1"]}' },
			],
			source: modelSource(),
		},
	}, { surfaceOp: 'append' });
	session.append('tool/call', {
		turn: 1,
		step: 1,
		callId: 'call-1',
		name: 'read_turn_nodes',
		arguments: '{"ids":["n1"]}',
	});
	session.append('tool/result', {
		turn: 1,
		step: 1,
		message: {
			id: 't1',
			role: 'tool',
			toolCallId: 'call-1',
			source: { kind: 'tool', callId: 'call-1' },
			content: [{ type: 'text', text: 'tool output' }],
		},
	}, { surfaceOp: 'append' });
	session.append('step/end', { turn: 1, step: 1 });
	session.append('step/start', { turn: 1, step: 2 });
	session.append('assistant/message', {
		turn: 1,
		step: 2,
		message: {
			id: 'a2',
			role: 'assistant',
			content: [{ type: 'text', text: 'final answer' }],
			source: modelSource(),
		},
	}, { surfaceOp: 'append' });
	session.append('step/end', { turn: 1, step: 2 });
	session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
	return session;
}

function editorFor(): TurnNodeEditor {
	return new TurnNodeEditor([
		{ kind: 'user', content: 'original question', sourceSeq: 1 },
		{ kind: 'assistant', content: 'original answer', sourceSeq: 3 },
	]);
}

function toolTurnEditor(): TurnNodeEditor {
	return new TurnNodeEditor([
		{ kind: 'user', content: 'original question', sourceSeq: 1 },
		{ kind: 'assistant', content: 'let me look', sourceSeq: 3, toolCallIds: ['call-1'] },
		{ kind: 'tool', content: 'tool output', sourceSeq: 5, toolResultCallId: 'call-1' },
		{ kind: 'assistant', content: 'final answer', sourceSeq: 8 },
	]);
}

function jobFor(session: any, editor: TurnNodeEditor, targetSeqs: number[]): any {
	return { id: 'draft-1', session, turn: 1, targetSeqs, editor, mutationCount: 1, workerNumber: 1 };
}

/** The logical V4 header; the physical `type: 'session'` wrapper is stripped by the codec. */
function header(): any {
	return {
		version: 4,
		id: 'session-00000000-0000-4000-8000-000000000001',
		createdAt: 1792425682489,
		cwd: '/home/vilicvane/projects/vilicvane/dsh-plugins',
		isSeeded: false,
		delegationDepth: 0,
		agentPreset: 'standard',
	};
}

/** Hand the landed log to the runtime's own released V4 readers. */
function validateSessionLog(session: any): any {
	const artifact = { header: header(), events: session.events, inheritedEventCount: 0 };
	for (const event of artifact.events) validators!.assertV4RowAdmission(event);
	return validators!.restoreReleasedV4Artifact(artifact, knownEventTypes!);
}

/** Land one compression draft and validate the resulting log. */
function landAndValidate(session: any, editor: TurnNodeEditor, targetSeqs: number[]): any[] {
	const job = jobFor(session, editor, targetSeqs);
	const from = session.events.length;
	validateLanding(job, false);
	land(job);
	validateSessionLog(session);
	return session.events.slice(from);
}

const skip = unavailable ?? false;

describe('compression landings satisfy the released V4 relational invariant', { skip }, () => {
	test('an unchanged turn lands as a loadable marker copy', () => {
		const landed = landAndValidate(completedTurnSession(), editorFor(), [1, 3]);
		assert.equal(landed.length, 1);
		assert.equal(landed[0].type, 'user/message');
		assert.deepEqual(landed[0].surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 });
	});

	test('a user-only rewrite lands as a loadable replacement', () => {
		const session = completedTurnSession();
		const editor = editorFor();
		editor.replace('n1', 'n1', [{ kind: 'user', content: 'rewritten question' }]);
		const landed = landAndValidate(session, editor, [1, 3]);
		assert.equal(landed.length, 1);
		assert.equal(landed[0].type, 'user/message');
		assert.deepEqual(landed[0].data.content, [{ type: 'text', text: 'rewritten question' }]);
	});

	test('a changed assistant node lands as a loadable checkpoint instead of an assistant append', () => {
		const session = completedTurnSession();
		const editor = editorFor();
		editor.replace('n2', 'n2', [{ kind: 'assistant', content: 'rewritten answer' }]);
		const landed = landAndValidate(session, editor, [1, 3]);
		assert.equal(landed.length, 1);
		const [event] = landed;
		assert.equal(event.type, 'user/message');
		assert.deepEqual(event.data.content, [{
			type: 'text',
			text: 'User: original question\n\nAssistant: rewritten answer',
		}]);
		assert.deepEqual(event.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 3 });
		assert.deepEqual(event.sourceEventSeqs, [1, 3]);
	});

	test('a checkpoint may shadow a closed tool result', () => {
		const session = toolTurnSession();
		const editor = toolTurnEditor();
		editor.replace('n2', 'n3', [{ kind: 'assistant', content: 'merged answer' }]);
		const landed = landAndValidate(session, editor, [1, 3, 5, 8]);
		assert.equal(landed.length, 1);
		const [event] = landed;
		assert.equal(event.type, 'user/message');
		assert.deepEqual(event.data.content, [{
			type: 'text',
			text: 'User: original question\n\nAssistant: merged answer\n\nAssistant: final answer',
		}]);
		assert.deepEqual(event.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 8 });
		assert.deepEqual([...event.sourceEventSeqs].sort((a, b) => a - b), [1, 3, 5, 8]);
	});

	test('every landing branch leaves the log loadable and appends only user/message', () => {
		const branches = [
			(editor: TurnNodeEditor) => editor,
			(editor: TurnNodeEditor) => (editor.replace('n1', 'n1', [{ kind: 'user', content: 'q2' }]), editor),
			(editor: TurnNodeEditor) => (editor.replace('n2', 'n2', [{ kind: 'assistant', content: 'a2' }]), editor),
		];
		for (const branch of branches) {
			const session = completedTurnSession();
			const landed = landAndValidate(session, branch(editorFor()), [1, 3]);
			assert.ok(landed.length > 0);
			assert.ok(landed.every((event) => event.type === 'user/message'));
			assert.ok(landed.every((event) => event.data.source.kind === 'turn-memory-compression'));
			// The landed marker keeps `compressedTurnNumbers()` from re-compressing the turn.
			assert.equal(landed.at(-1)!.data.source.turn, 1);
		}
	});

	test('the invariant still rejects the old post-turn assistant append', () => {
		const session = completedTurnSession();
		// Exactly the shape the removed landing mode wrote: a copy of the closed
		// turn's assistant message appended after `turn/end`, citing that turn/step.
		session.append('assistant/message', {
			turn: 1,
			step: 1,
			source: { kind: 'turn-memory-compression', turn: 1, draftId: 'draft-1', originalNodes: 2, mutations: 1, workerAttempts: 1 },
			message: {
				id: 'a-stale',
				role: 'assistant',
				content: [{ type: 'text', text: 'original answer' }],
				source: modelSource(),
			},
		}, { surfaceOp: 'append' });
		assert.throws(
			() => validateSessionLog(session),
			/assistant\/message does not match an open turn and step/,
		);
	});

	test('the invariant rejects a stale tool/result replacement after turn/end', () => {
		const session = toolTurnSession();
		// A structural tool rewrite cannot land after the turn closed either: even a
		// non-append tool/result needs an open turn.
		session.append(
			'tool/result',
			{
				turn: 1,
				step: 1,
				message: {
					id: 't2',
					role: 'tool',
					toolCallId: 'call-1',
					source: { kind: 'tool', callId: 'call-1' },
					content: [{ type: 'text', text: 'rewritten tool output' }],
				},
			},
			{ surfaceOp: { op: 'replace', startSeq: 5, endSeq: 5 }, sourceEventSeqs: [5] },
		);
		assert.throws(() => validateSessionLog(session), /tool\/result is outside an open turn/);
	});
});
