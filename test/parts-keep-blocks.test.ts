/**
 * A message ingress splits into parts goes out as the message it was,
 * wherever its parts render: its thinking, images, tool calls and tool
 * results go out with its text, each once, ahead of the text, and a call's
 * result goes out right after the call. The parts sent raw together are
 * joined into one entry, and so is a part sent raw alone. The middle region
 * used to join its parts' text alone, so a long reply lost its thinking and
 * its call there, and pairing repair then dropped the call's result too.
 * Each part is sent as the windows send it, cut at maxMessageTokens, and
 * priced at what it sends; each image keeps or loses its place by its own
 * part's verdict.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { OverBudgetError } from '../src/index.js';
import { call, image, long, open, result, sum, text, thinking, type Kind, type Layout } from './body-parts-harness.js';

const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };
const KINDS: Kind[] = ['adaptive', 'kv-unified'];
const LAYOUTS: Layout[] = ['new', 'old'];
const STUB = "this call's result isn't shown";

type Sent = { participant: string; content: ContentBlock[] };
const textOf = (m: Sent): string => m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : '')).join('');
const allText = (sent: Sent[]): string => sent.map(textOf).join('');
const blocks = (sent: Sent[], test: (b: ContentBlock) => boolean): ContentBlock[] =>
  sent.flatMap((m) => m.content.filter(test));
const images = (sent: Sent[], data: string): number =>
  sent.flatMap((m) => m.content).filter((b) =>
    JSON.stringify(b).includes(`"data":"${data}"`)).length;
const isCall = (id: string) => (b: ContentBlock): boolean => b.type === 'tool_use' && (b as { id: string }).id === id;
const isResult = (id: string) => (b: ContentBlock): boolean =>
  b.type === 'tool_result' && (b as { toolUseId: string }).toolUseId === id;
/** No text block comes before a non-text block in `m`. */
const nonTextFirst = (m: Sent): boolean => {
  const firstText = m.content.findIndex((b) => b.type === 'text');
  return firstText < 0 || m.content.slice(firstText).every((b) => b.type === 'text');
};

/** A reply with thinking and a call, its result, and a document with an image
 *  between two texts, each long enough to split. */
async function story(layout: Layout, kind: Kind, config: Record<string, unknown> = {}) {
  const o = await open({ layout, kind, config: { headWindowTokens: 0, recentWindowTokens: 1_000_000, ...config } });
  o.add('u', [text('intro')]);
  const reply = o.add('a', [thinking('THINK-REPLY'), text(long('REPLY')), call('call-1')]);
  const [res] = o.add('u', [result('call-1', 'RESULT-MARK what the tool said')]);
  o.add('a', [text('ok')]);
  const doc = o.add('u', [text('DOC-HEAD '), image('AAAA'), text(long('DOC'))]);
  o.add('a', [text('ok')]);
  o.add('u', [text('next')]);
  return { ...o, reply, res: res!, doc };
}

/** Where the reply's parts render, set after the messages are stored. */
const PLACES: Record<string, {
  set: (s: Awaited<ReturnType<typeof story>>) => void;
  premise: (s: Awaited<ReturnType<typeof story>>, layout: Layout) => string | undefined;
}> = {
  'in the head window': {
    set: (s) => s.strategy.set({ headWindowTokens: 10_000_000, recentWindowTokens: 300 }),
    premise: (s) => (s.strategy.headEnd(s.view()) === s.all().length ? undefined : 'the head holds every message'),
  },
  'raw in the middle': {
    set: (s) => s.strategy.set({ headWindowTokens: 0, recentWindowTokens: 300 }),
    premise: (s) => (s.strategy.recentStart(s.view()) > s.doc.at(-1)! ? undefined : 'the recent window starts after the document'),
  },
  'across the middle and the recent window': {
    // The recent window's walk crosses into the reply at its last part.
    set: (s) => s.strategy.set({ headWindowTokens: 0, recentWindowTokens: sum(s.strategy.walkPrices(s.view()), s.reply.at(-1)!) }),
    premise: (s, layout) => {
      const start = s.strategy.recentStart(s.view());
      // A reply stored with its call on its first part starts the window there.
      const expected = layout === 'new' ? s.reply.at(-1)! : s.reply[0]!;
      return start === expected ? undefined : `the recent window starts at ${expected}, not ${start}`;
    },
  },
  'in the recent window': {
    set: (s) => s.strategy.set({ headWindowTokens: 0, recentWindowTokens: 1_000_000 }),
    premise: (s) => (s.strategy.recentStart(s.view()) === 0 ? undefined : 'the recent window holds every message'),
  },
};

describe("a message stored in parts goes out with every block it was stored with, wherever its parts render", () => {
  for (const kind of KINDS) {
    for (const layout of LAYOUTS) {
      for (const [place, { set, premise }] of Object.entries(PLACES)) {
        it(`${kind}, stored as ${layout === 'new' ? 'ingress stores it now' : 'ingress stored it before'}, ${place}`, async () => {
          const s = await story(layout, kind);
          try {
            const parts = s.all();
            const first = parts[s.reply[0]!]!.content.map((b) => b.type);
            const last = parts[s.reply.at(-1)!]!.content.map((b) => b.type);
            assert.ok(s.reply.length >= 6, `premise: the reply is stored in ${s.reply.length} parts`);
            assert.deepEqual([first, last], layout === 'new'
              ? [['text', 'thinking'], ['text', 'tool_use']]
              : [['text', 'thinking', 'tool_use'], ['text']], 'premise: where the reply\'s blocks are stored');
            set(s);
            assert.equal(premise(s, layout), undefined, 'premise: where the parts render');

            const sent = (await s.manager.compile(BIG)).messages as Sent[];
            assert.equal(blocks(sent, (b) => b.type === 'thinking').length, 1, 'the reply\'s thinking goes out once');
            assert.equal(blocks(sent, isCall('call-1')).length, 1, 'its call goes out once');
            const at = sent.findIndex((m) => m.content.some(isCall('call-1')));
            const answer = sent[at + 1]?.content.find(isResult('call-1')) as { content?: unknown } | undefined;
            assert.equal(answer?.content, 'RESULT-MARK what the tool said', 'the call\'s own result goes out right after it');
            assert.ok(!JSON.stringify(sent).includes(STUB), 'no stub stands in for the result');
            assert.equal(images(sent, 'AAAA'), 1, 'the document\'s image goes out once');
            assert.ok(allText(sent).includes(long('REPLY')) && allText(sent).includes(long('DOC')), 'each text goes out whole, in order');
            for (const m of sent.filter((m) => textOf(m).includes('lorem'))) {
              assert.ok(nonTextFirst(m), `a joined entry sends its other blocks ahead of its text: ${m.content.map((b) => b.type)}`);
            }
          } finally {
            await s.close();
          }
        });
      }
    }
  }
});

describe('raw in the adaptive middle, a body with thinking, a call and an image is priced as every part it sends', () => {
  for (const layout of LAYOUTS) {
    it(`stored as ${layout === 'new' ? 'ingress stores it now' : 'ingress stored it before'}: the plan, the emission and the render stats count every part, and a budget of that sends it all where one less is refused`, async () => {
      const s = await story(layout, 'adaptive', { headWindowTokens: 0, recentWindowTokens: 300 });
      try {
        assert.ok(s.strategy.recentStart(s.view()) > s.doc.at(-1)!, 'premise: the bodies render in the middle');
        const parts = sum(s.estimates(), 0);
        const compiled = await s.manager.compile(BIG);
        assert.equal(images(compiled.messages as Sent[], 'AAAA'), 1, 'premise: the middle sends the image');
        const stats = s.manager.getRenderStats()!;
        const { planned, actual } = stats.planVsActual!;
        assert.deepEqual([planned, actual, stats.total.tokens], [parts, parts, parts],
          `planned ${planned}, emitted ${actual}, render stats ${stats.total.tokens}, every part ${parts}`);
        await s.manager.compile({ maxTokens: parts, reserveForResponse: 0 });
        await assert.rejects(s.manager.compile({ maxTokens: parts - 1, reserveForResponse: 0 }), OverBudgetError);
      } finally {
        await s.close();
      }
    });
  }
});

describe('a part sent raw alone goes out with its other blocks ahead of its text', () => {
  for (const kind of KINDS) {
    it(`${kind}: the head ending after a long reply's first part sends its thinking first`, async () => {
      const o = await open({ kind, config: { headWindowTokens: 10_000_000, recentWindowTokens: 300 } });
      try {
        o.add('u', [text('intro')]);
        const reply = o.add('a', [thinking('THINK-LONE'), text(long('LONE'))]);
        o.add('u', [text('next')]);
        o.add('a', [text('ok')]);
        o.strategy.set({ headWindowTokens: sum(o.estimates(), 0, reply[0]! + 1) });
        assert.equal(o.strategy.headEnd(o.view()), reply[0]! + 1, 'premise: the head ends after the reply\'s first part');
        assert.deepEqual(o.all()[reply[0]!]!.content.map((b) => b.type), ['text', 'thinking'], 'premise: the part is stored text first');
        const sent = (await o.manager.compile(BIG)).messages as Sent[];
        assert.deepEqual(sent[1]!.content.map((b) => b.type), ['thinking', 'text'], 'the head\'s last entry is the part, thinking first');
      } finally {
        await o.close();
      }
    });
  }
});

describe('a long string result on a part is cut alike wherever the part renders', () => {
  for (const kind of KINDS) {
    it(`${kind}: at maxMessageTokens 10,000, the head, the middle and the recent window send the same cut`, async () => {
      const got: Record<string, unknown> = {};
      for (const [where, config] of Object.entries({
        head: { headWindowTokens: 10_000_000, recentWindowTokens: 300 },
        middle: { headWindowTokens: 0, recentWindowTokens: 300 },
        recent: { headWindowTokens: 0, recentWindowTokens: 1_000_000 },
      })) {
        const o = await open({ kind, config: { ...config, maxMessageTokens: 10_000 } });
        try {
          o.add('u', [text('intro')]);
          o.add('a', [call('call-9')]);
          const parts = o.add('u', [result('call-9', long('RESULT', 60_000)), text(long('AFTER'))]);
          o.add('a', [text('ok')]);
          o.add('u', [text('next')]);
          assert.ok(parts.length > 1 && o.all()[parts[0]!]!.content.some(isResult('call-9')), 'premise: the result is stored on the body\'s first part');
          const sent = (await o.manager.compile(BIG)).messages as Sent[];
          const answer = blocks(sent, isResult('call-9'));
          assert.equal(answer.length, 1, `${where}: the result goes out once`);
          got[where] = (answer[0] as { content: unknown }).content;
          assert.ok(typeof got[where] === 'string' && (got[where] as string).length < long('RESULT', 60_000).length,
            `${where}: the cap cuts it`);
        } finally {
          await o.close();
        }
      }
      assert.equal(got.middle, got.head, 'the middle cuts it as the head does');
      assert.equal(got.recent, got.head, 'the recent window cuts it as the head does');
    });
  }
});

describe("each image keeps or loses its place by its own part's verdict", () => {
  // A document with its image on its first part, and a reply whose image is
  // stored after its call, so on its last part.
  async function images2(kind: Kind, config: Record<string, unknown>) {
    const o = await open({ kind, config: { headWindowTokens: 0, ...config } });
    o.add('u', [text('intro')]);
    const doc = o.add('u', [text('DOC-HEAD '), image('AAAA'), text(long('DOC'))]);
    o.add('a', [text('ok')]);
    const shot = o.add('a', [text(long('SHOT')), call('call-5'), image('BBBB')]);
    o.add('u', [result('call-5', 'shot taken')]);
    o.add('a', [text('ok')]);
    o.add('u', [text('next')]);
    assert.ok(o.all()[doc[0]!]!.content.some((b) => b.type === 'image'), 'premise: the document\'s image is on its first part');
    assert.ok(o.all()[shot.at(-1)!]!.content.some((b) => b.type === 'image'), 'premise: the reply\'s image is on its last part');
    return { ...o, doc, shot };
  }
  for (const kind of KINDS) {
    for (const [where, recentWindowTokens] of Object.entries({ 'raw in the middle': 300, 'in the recent window': 1_000_000 })) {
      it(`${kind}, ${where}: under maxLiveImages, both images keep their place`, async () => {
        const o = await images2(kind, { recentWindowTokens, maxLiveImages: 2 });
        try {
          const sent = (await o.manager.compile(BIG)).messages as Sent[];
          assert.deepEqual([images(sent, 'AAAA'), images(sent, 'BBBB')], [1, 1], 'both images go out');
        } finally {
          await o.close();
        }
      });
      it(`${kind}, ${where}: a depth limit falling inside the reply keeps the image on its last part and strips the older one`, async () => {
        const o = await images2(kind, { recentWindowTokens });
        try {
          // The strip starts at the reply's last part (getImageStripStart).
          o.strategy.set({ imageStripDepthTokens: sum(o.estimates(), o.shot.at(-1)!) });
          const sent = (await o.manager.compile(BIG)).messages as Sent[];
          assert.deepEqual([images(sent, 'AAAA'), images(sent, 'BBBB')], [0, 1], 'the reply\'s image goes out, the document\'s doesn\'t');
          assert.ok(allText(sent).includes('[image not shown'), 'the stripped image leaves its placeholder');
        } finally {
          await o.close();
        }
      });
    }
  }
});

describe("an image in a result pairing repair moves out of a joined entry keeps its own part's verdict", () => {
  for (const kind of KINDS) {
    it(`${kind}: a result stored on a long message's first part, a message after its call, goes up beside the call with its image`, async () => {
      const o = await open({ kind, config: { headWindowTokens: 0, recentWindowTokens: 300, maxLiveImages: 2 } });
      try {
        o.add('u', [text('intro')]);
        o.add('a', [call('call-7')]);
        o.add('u', [text('meanwhile')]);
        const res = o.add('u', [result('call-7', [image('CCCC'), text('shot')]), text(long('RES'))]);
        o.add('a', [text('ok')]);
        o.add('u', [text('next')]);
        assert.ok(res.length > 1 && o.all()[res[0]!]!.content.some(isResult('call-7')), 'premise: the result is on its body\'s first part');
        const sent = (await o.manager.compile(BIG)).messages as Sent[];
        const at = sent.findIndex((m) => m.content.some(isCall('call-7')));
        assert.ok(sent[at + 1]?.content.some(isResult('call-7')), 'premise: pairing repair moved the result up beside its call');
        assert.equal(images(sent, 'CCCC'), 1, 'its image goes out');
      } finally {
        await o.close();
      }
    });
  }
});

describe("a body's bytes stay put while its parts stay in their region", () => {
  for (const kind of KINDS) {
    it(`${kind}: one compile a turn while the recent window's edge crosses a reply with a call`, async () => {
      const o = await open({ kind, config: { headWindowTokens: 0, recentWindowTokens: 12_000 } });
      try {
        o.add('u', [text('intro')]);
        const reply = o.add('a', [thinking('THINK-REPLY'), text(long('REPLY')), call('call-1')]);
        const [res] = o.add('u', [result('call-1', 'RESULT-MARK what the tool said')]);
        const ids = o.all().map((m) => m.id);
        const bodyIds = new Set([...reply.map((i) => ids[i]!), ids[res!]!]);
        let before: { regions: string; bytes: string } | undefined;
        let compared = 0;
        let crossed = 0;
        for (let turn = 0; turn < 40; turn++) {
          o.add(turn % 2 ? 'u' : 'a', [text(`turn ${turn} ${long('T', 4_000)}`)]);
          const start = o.strategy.recentStart(o.view());
          const positions = o.all().map((m) => m.id);
          const regions = [...bodyIds].map((id) => (positions.indexOf(id) >= start ? 'recent' : 'middle')).join(',');
          if (regions.includes('recent') && regions.includes('middle')) crossed++;
          const sent = (await o.manager.compile(BIG)).messages as Sent[];
          const at = sent.findIndex((m) => m.content.some(isCall('call-1')));
          assert.ok(sent[at + 1]?.content.some(isResult('call-1')), `turn ${turn}: the call's result follows it`);
          // What the provider reads: each entry's participant and content.
          const bytes = JSON.stringify(sent
            .filter((m) => textOf(m).includes('REPLY') || m.content.some(isCall('call-1')) || m.content.some(isResult('call-1')))
            .map((m) => ({ participant: m.participant, content: m.content })));
          if (before && before.regions === regions) {
            let at = 0;
            while (at < bytes.length && bytes[at] === before.bytes[at]) at++;
            assert.ok(at === bytes.length && at === before.bytes.length,
              `turn ${turn}: the body's bytes are unchanged while its parts stay put (${regions}); they differ at ${at}: ` +
              `${JSON.stringify(before.bytes.slice(Math.max(0, at - 80), at + 120))} became ${JSON.stringify(bytes.slice(Math.max(0, at - 80), at + 120))}`);
            compared++;
          }
          before = { regions, bytes };
        }
        assert.ok(crossed > 0 && compared > 10, `premise: the edge crossed the body (${crossed} turns) and turns were compared (${compared})`);
      } finally {
        await o.close();
      }
    });
  }
});
