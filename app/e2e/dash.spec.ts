import { expect, test } from '@playwright/test'
import {
  DashError,
  listVideoQualities,
  MAX_SEGMENTS,
  parseMpd,
  planRepresentation,
  planSelection,
  selectRepresentations,
  type DashErrorCode,
  type Mpd,
  type Representation,
  type TrackPlan
} from '../src/main/media/dash'
import { parseXml } from '../src/main/media/dash/xml'

// The DASH module: static MPDs in, segment requests out. Pure functions, so every fixture is an
// inline MPD shaped like what packagers (FFmpeg, Shaka Packager, GPAC, Unified Streaming) write.

const MPD_URL = 'https://media.example.com/vod/show/manifest.mpd'
const BASE = 'https://media.example.com/vod/show/'

/** A static single-period MPD around `period`. */
function staticMpd(
  period: string,
  { mpdAttrs = 'mediaPresentationDuration="PT30S"', head = '', periodAttrs = '' } = {}
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" minBufferTime="PT2S"
     profiles="urn:mpeg:dash:profile:isoff-live:2011" ${mpdAttrs}>
  ${head}
  <Period id="p0" ${periodAttrs}>
    ${period}
  </Period>
</MPD>`
}

const V720 = '<Representation id="v1" bandwidth="2000000" width="1280" height="720"/>'

/** A video adaptation set holding `inner` (segment information) and `representations`. */
function videoSet(inner: string, representations = V720): string {
  return `<AdaptationSet contentType="video" mimeType="video/mp4">${inner}${representations}</AdaptationSet>`
}

function firstRepresentation(mpd: Mpd): Representation {
  return mpd.adaptationSets[0].representations[0]
}

/** The plan for the first representation of the first adaptation set. */
function planFirst(xml: string | Uint8Array, url = MPD_URL): TrackPlan {
  const mpd = parseMpd(xml, url)
  return planRepresentation(mpd, firstRepresentation(mpd))
}

function mediaUrls(plan: TrackPlan): string[] {
  return plan.media.map((request) => request.url)
}

function caught(action: () => unknown): DashError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(DashError)
    return error as DashError
  }
  throw new Error('expected a DashError')
}

function expectRefusal(action: () => unknown, code: DashErrorCode, message?: RegExp): void {
  const error = caught(action)
  expect(error.code, error.message).toBe(code)
  if (message) expect(error.message).toMatch(message)
}

/** A typical live-profile MPD: 60.5 s, 4 s segments, video and audio templates. */
const SIMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011"
     type="static" mediaPresentationDuration="PT1M0.5S" minBufferTime="PT2S">
  <Period id="0" start="PT0S">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate timescale="90000" duration="360000" startNumber="1"
        initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%05d$.m4s"/>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028" frameRate="30"/>
      <Representation id="v720" bandwidth="3000000" width="1280" height="720" codecs="avc1.64001f"/>
      <Representation id="v480" bandwidth="1200000" width="854" height="480" codecs="avc1.64001e"/>
    </AdaptationSet>
    <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" lang="en">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
      <SegmentTemplate timescale="48000" duration="192000"
        initialization="audio/$RepresentationID$/init.mp4" media="audio/$RepresentationID$/$Number$.m4s"/>
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="48000">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

test.describe('DASH SegmentTemplate addressing @smoke', () => {
  test('simple addressing counts segments from the duration and pads $Number%05d$', () => {
    const mpd = parseMpd(SIMPLE, MPD_URL)
    expect(mpd.url).toBe(MPD_URL)
    expect(mpd.durationSeconds).toBe(60.5)
    expect(mpd.adaptationSets.map((set) => set.contentType)).toEqual(['video', 'audio'])
    const [v1080] = mpd.adaptationSets[0].representations
    expect(v1080).toMatchObject({
      id: 'v1080',
      bandwidth: 5_000_000,
      width: 1920,
      height: 1080,
      codecs: 'avc1.640028',
      mimeType: 'video/mp4',
      contentType: 'video',
      protected: false
    })

    // 60.5 s of 4 s segments: ceil(15.125) = 16, the last one short.
    const video = planRepresentation(mpd, v1080)
    expect(video.init).toEqual({ url: `${BASE}v1080/init.mp4` })
    expect(video.media).toHaveLength(16)
    expect(video.media[0]).toEqual({ url: `${BASE}v1080/seg-00001.m4s` })
    expect(video.media[15]).toEqual({ url: `${BASE}v1080/seg-00016.m4s` })
    expect(video.requests).toEqual([video.init, ...video.media])
    expect(video.representationId).toBe('v1080')

    const audio = planRepresentation(mpd, mpd.adaptationSets[1].representations[0])
    expect(audio.init).toEqual({ url: `${BASE}audio/a128/init.mp4` })
    expect(mediaUrls(audio)).toEqual(
      Array.from({ length: 16 }, (_, i) => `${BASE}audio/a128/${i + 1}.m4s`)
    )
  })

  test('segment counts use exact decimal arithmetic, not floating point', () => {
    const count = (duration: string, timescale: number, segment: number): number =>
      planFirst(
        staticMpd(
          videoSet(
            `<SegmentTemplate timescale="${timescale}" duration="${segment}" media="$Number$.m4s"/>`
          ),
          { mpdAttrs: `mediaPresentationDuration="${duration}"` }
        )
      ).media.length
    // 0.3 × 10 is 3.0000000000000004 in floating point, which would round up to 4.
    expect(count('PT0.3S', 10, 1)).toBe(3)
    expect(count('PT634.566S', 1000, 2000)).toBe(318)
    expect(count('PT8S', 1, 4)).toBe(2)
    expect(count('PT8.001S', 1, 4)).toBe(3)
    expect(count('P0Y0M0DT0H1M0.000S', 1, 6)).toBe(10)
    expect(count('P1DT1H', 1, 3600)).toBe(25)
  })

  test('$RepresentationID$, $Bandwidth$, $Time$, $$ and widths are filled in as DASH says', () => {
    const plan = planFirst(
      staticMpd(
        videoSet(
          `<SegmentTemplate timescale="1000" duration="2000" startNumber="99" presentationTimeOffset="500"
             initialization="init-$Bandwidth$-$RepresentationID$.mp4"
             media="$$Bandwidth$$/$Bandwidth%09d$/$RepresentationID$/$Number%02d$_$Time%06d$.m4s"/>`
        ),
        { mpdAttrs: 'mediaPresentationDuration="PT6S"' }
      )
    )
    expect(plan.init).toEqual({ url: `${BASE}init-2000000-v1.mp4` })
    // A value longer than its width isn't cut: 100 stays 100 under %02d.
    expect(mediaUrls(plan)).toEqual([
      `${BASE}$Bandwidth$/002000000/v1/99_000500.m4s`,
      `${BASE}$Bandwidth$/002000000/v1/100_002500.m4s`,
      `${BASE}$Bandwidth$/002000000/v1/101_004500.m4s`
    ])
  })

  test('startNumber 0 and endNumber bound the numbers', () => {
    const plan = planFirst(
      staticMpd(
        videoSet(
          '<SegmentTemplate timescale="1" duration="1" startNumber="0" endNumber="2" media="$Number$.m4s"/>'
        )
      )
    )
    expect(mediaUrls(plan)).toEqual([`${BASE}0.m4s`, `${BASE}1.m4s`, `${BASE}2.m4s`])
  })

  test('a template with neither duration nor timeline is one segment', () => {
    const plan = planFirst(
      staticMpd(
        videoSet(
          '<SegmentTemplate media="whole-$RepresentationID$.mp4"><Initialization sourceURL="init/header.mp4" range="0-999"/></SegmentTemplate>'
        )
      )
    )
    expect(plan.init).toEqual({ url: `${BASE}init/header.mp4`, range: { start: 0, end: 999 } })
    expect(mediaUrls(plan)).toEqual([`${BASE}whole-v1.mp4`])
  })

  test('a template with an Initialization range but no sourceURL points into the base', () => {
    const plan = planFirst(
      staticMpd(
        videoSet(
          '<SegmentTemplate media="$Number$.m4s" duration="10" timescale="1"><Initialization range="0-99"/></SegmentTemplate>',
          `<Representation id="v1" bandwidth="1"><BaseURL>v1/</BaseURL></Representation>`
        )
      )
    )
    expect(plan.init).toEqual({ url: `${BASE}v1/`, range: { start: 0, end: 99 } })
    expect(plan.media).toHaveLength(3)
  })
})

test.describe('DASH SegmentTimeline @smoke', () => {
  const timeline = (
    entries: string,
    attrs = '',
    media = 'chunk-$RepresentationID$-$Time$.m4s'
  ): string =>
    videoSet(
      `<SegmentTemplate timescale="1000" initialization="init-$RepresentationID$.mp4" media="${media}" ${attrs}>
         <SegmentTimeline>${entries}</SegmentTimeline>
       </SegmentTemplate>`
    )

  test('t, d and r, an explicit gap, and r=-1 running to the end of the period', () => {
    const plan = planFirst(
      staticMpd(
        timeline(`<S t="0" d="4000" r="2"/>
                  <S d="3000"/>
                  <S t="20000" d="2000" r="1"/>
                  <S d="2000" r="-1"/>`)
      )
    )
    expect(plan.init).toEqual({ url: `${BASE}init-v1.mp4` })
    // r=-1 on the last S: from 24 s to the period's end at 30 s, ceil(6000 / 2000) = 3.
    const times = [0, 4000, 8000, 12000, 20000, 22000, 24000, 26000, 28000]
    expect(mediaUrls(plan)).toEqual(times.map((t) => `${BASE}chunk-v1-${t}.m4s`))
  })

  test('$Number$ runs on from startNumber across S entries', () => {
    const plan = planFirst(
      staticMpd(
        timeline('<S t="0" d="2000" r="1"/><S d="1000" r="1"/>', 'startNumber="5"', '$Number$.m4s')
      )
    )
    expect(mediaUrls(plan)).toEqual([5, 6, 7, 8].map((n) => `${BASE}${n}.m4s`))
  })

  test('r=-1 before another S repeats up to that S@t', () => {
    const plan = planFirst(staticMpd(timeline('<S t="0" d="2000" r="-1"/><S t="7000" d="1000"/>')))
    const times = [0, 2000, 4000, 6000, 7000]
    expect(mediaUrls(plan)).toEqual(times.map((t) => `${BASE}chunk-v1-${t}.m4s`))
  })

  test('r=-1 ends at presentationTimeOffset + Period@duration, which beats the MPD duration', () => {
    const plan = planFirst(
      staticMpd(timeline('<S t="100000" d="5000" r="-1"/>', 'presentationTimeOffset="100000"'), {
        mpdAttrs: 'mediaPresentationDuration="PT100S"',
        periodAttrs: 'duration="PT12S"'
      })
    )
    const times = [100000, 105000, 110000]
    expect(mediaUrls(plan)).toEqual(times.map((t) => `${BASE}chunk-v1-${t}.m4s`))
  })

  test('the first S without @t starts at 0, and an S past the period end adds nothing', () => {
    const plan = planFirst(staticMpd(timeline('<S d="1000" r="1"/><S t="40000" d="1000" r="-1"/>')))
    expect(mediaUrls(plan)).toEqual([`${BASE}chunk-v1-0.m4s`, `${BASE}chunk-v1-1000.m4s`])
  })

  test('$Time$ beyond 2^53 is exact', () => {
    const plan = planFirst(staticMpd(timeline('<S t="9007199254740993" d="1" r="1"/>')))
    expect(mediaUrls(plan)).toEqual([
      `${BASE}chunk-v1-9007199254740993.m4s`,
      `${BASE}chunk-v1-9007199254740994.m4s`
    ])
  })

  test('endNumber cuts a timeline short', () => {
    const plan = planFirst(
      staticMpd(timeline('<S d="1000" r="9"/><S d="500" r="3"/>', 'endNumber="3"', '$Number$.m4s'))
    )
    expect(mediaUrls(plan)).toEqual([1, 2, 3].map((n) => `${BASE}${n}.m4s`))
  })

  test('the Period@start comes off the presentation duration', () => {
    const mpd = parseMpd(
      staticMpd(videoSet('<SegmentTemplate media="$Number$.m4s" duration="5" timescale="1"/>'), {
        periodAttrs: 'start="PT10S"'
      }),
      MPD_URL
    )
    expect(mpd.durationSeconds).toBe(20)
    expect(planRepresentation(mpd, firstRepresentation(mpd)).media).toHaveLength(4)
  })
})

test.describe('DASH SegmentList and SegmentBase @smoke', () => {
  test('SegmentList: an init file and segment files under the representation BaseURL', () => {
    const plan = planFirst(
      staticMpd(
        videoSet(
          '',
          `<Representation id="sl" bandwidth="800000" width="640" height="360" codecs="avc1.4d401e">
             <BaseURL>video/360p/</BaseURL>
             <SegmentList timescale="1000" duration="10000">
               <Initialization sourceURL="init.mp4"/>
               <SegmentURL media="seg1.m4s"/>
               <SegmentURL media="seg2.m4s"/>
               <SegmentURL media="seg3.m4s"/>
             </SegmentList>
           </Representation>`
        )
      )
    )
    expect(plan.init).toEqual({ url: `${BASE}video/360p/init.mp4` })
    expect(mediaUrls(plan)).toEqual([1, 2, 3].map((n) => `${BASE}video/360p/seg${n}.m4s`))
  })

  test('SegmentList: byte ranges into one file', () => {
    const plan = planFirst(
      staticMpd(
        videoSet(
          '',
          `<Representation id="ranged" bandwidth="800000">
             <BaseURL>https://cdn.example.net/files/movie_360.mp4</BaseURL>
             <SegmentList duration="10">
               <Initialization range="0-861"/>
               <SegmentURL mediaRange="862-50000"/>
               <SegmentURL mediaRange="50001-99999"/>
             </SegmentList>
           </Representation>`
        )
      )
    )
    const file = 'https://cdn.example.net/files/movie_360.mp4'
    expect(plan.requests).toEqual([
      { url: file, range: { start: 0, end: 861 } },
      { url: file, range: { start: 862, end: 50000 } },
      { url: file, range: { start: 50001, end: 99999 } }
    ])
  })

  test('SegmentBase: one file, with where its init segment and index sit', () => {
    const plan = planFirst(
      staticMpd(
        `<AdaptationSet mimeType="video/mp4" subsegmentAlignment="true">
           <Representation id="1" bandwidth="4190760" width="1920" height="1080" codecs="avc1.640028">
             <BaseURL>car-20120827-89.mp4</BaseURL>
             <SegmentBase indexRangeExact="true" indexRange="901-1680">
               <Initialization range="0-900"/>
             </SegmentBase>
           </Representation>
         </AdaptationSet>`
      )
    )
    expect(plan.init).toBeUndefined()
    expect(plan.requests).toEqual([{ url: `${BASE}car-20120827-89.mp4` }])
    expect(plan.initRange).toEqual({ start: 0, end: 900 })
    expect(plan.indexRange).toEqual({ start: 901, end: 1680 })
  })

  test('SegmentBase with a separate initialization file fetches it first', () => {
    const plan = planFirst(
      staticMpd(
        videoSet(
          '<SegmentBase indexRange="0-499"><Initialization sourceURL="init-v1.mp4"/></SegmentBase>',
          '<Representation id="v1" bandwidth="1"><BaseURL>v1.mp4</BaseURL></Representation>'
        )
      )
    )
    expect(plan.requests).toEqual([{ url: `${BASE}init-v1.mp4` }, { url: `${BASE}v1.mp4` }])
    expect(plan.initRange).toBeUndefined()
  })

  test('no segment information: the BaseURL is the whole file', () => {
    const plan = planFirst(
      staticMpd(
        `<AdaptationSet mimeType="video/webm">
           <Representation id="vp9" bandwidth="1500000" width="1280" height="720" codecs="vp9">
             <BaseURL>media/720.webm</BaseURL>
           </Representation>
         </AdaptationSet>`
      )
    )
    expect(plan.requests).toEqual([{ url: `${BASE}media/720.webm` }])
  })
})

test.describe('DASH BaseURL resolution @smoke', () => {
  const template = '<SegmentTemplate media="seg-$Number$.m4s" duration="15" timescale="1"/>'

  test('MPD → Period → AdaptationSet → Representation, each relative to the one above', () => {
    const plan = planFirst(
      staticMpd(
        `<BaseURL>p1/</BaseURL>
         <AdaptationSet mimeType="video/mp4"><BaseURL>video/</BaseURL>${template}
           <Representation id="v" bandwidth="1"><BaseURL>1080/</BaseURL></Representation>
         </AdaptationSet>`,
        {
          head: '<BaseURL>https://cdn.example.com/content/</BaseURL>'
        }
      )
    )
    expect(mediaUrls(plan)).toEqual([
      'https://cdn.example.com/content/p1/video/1080/seg-1.m4s',
      'https://cdn.example.com/content/p1/video/1080/seg-2.m4s'
    ])
  })

  test('dot segments, absolute overrides and absolute paths resolve as RFC 3986 says', () => {
    const mpd = parseMpd(
      staticMpd(
        `<AdaptationSet mimeType="video/mp4">${template}
           <Representation id="up" bandwidth="1"><BaseURL>a/</BaseURL></Representation>
         </AdaptationSet>
         <AdaptationSet mimeType="audio/mp4"><BaseURL> https://other.example.org/a/b/ </BaseURL>${template}
           <Representation id="abs" bandwidth="1"><BaseURL>/root/</BaseURL></Representation>
         </AdaptationSet>`,
        { head: '<BaseURL>../shared/</BaseURL><BaseURL>https://ignored.example.com/</BaseURL>' }
      ),
      MPD_URL
    )
    const [up, abs] = mpd.adaptationSets.map((set) => set.representations[0])
    expect(planRepresentation(mpd, up).media[0].url).toBe(
      'https://media.example.com/vod/shared/a/seg-1.m4s'
    )
    expect(planRepresentation(mpd, abs).media[0].url).toBe(
      'https://other.example.org/root/seg-1.m4s'
    )
  })

  test('a BaseURL without a trailing slash names a file, which the segment replaces', () => {
    const plan = planFirst(
      staticMpd(
        videoSet(
          template,
          '<Representation id="v" bandwidth="1"><BaseURL>video/1080</BaseURL></Representation>'
        )
      )
    )
    expect(plan.media[0].url).toBe(`${BASE}video/seg-1.m4s`)
  })

  test('with no BaseURL, segments resolve against the MPD address, query and all', () => {
    const plan = planFirst(
      staticMpd(videoSet(template)),
      'https://media.example.com/vod/show/manifest.mpd?token=abc'
    )
    expect(plan.media[0].url).toBe(`${BASE}seg-1.m4s`)
  })

  test('entities and CDATA in BaseURL and attributes are decoded', () => {
    const plan = planFirst(
      staticMpd(
        videoSet(
          '<SegmentTemplate media="s$Number$.m4s?a=1&amp;b=&#x32;" duration="30" timescale="1"/>',
          '<Representation id="v" bandwidth="1"><BaseURL><![CDATA[cdata/&dir/]]></BaseURL></Representation>'
        )
      )
    )
    expect(plan.media[0].url).toBe(`${BASE}cdata/&dir/s1.m4s?a=1&b=2`)
  })
})

test.describe('DASH segment information inheritance @smoke', () => {
  test('SegmentTemplate attributes merge from Period to Representation, lowest winning', () => {
    const mpd = parseMpd(
      staticMpd(
        `<SegmentTemplate timescale="1000" duration="10000"/>
         <AdaptationSet mimeType="video/mp4">
           <SegmentTemplate media="$RepresentationID$/$Number$.m4s" initialization="$RepresentationID$/init.mp4"/>
           <Representation id="a" bandwidth="1"/>
           <Representation id="b" bandwidth="1">
             <SegmentTemplate startNumber="7" duration="15000"/>
           </Representation>
         </AdaptationSet>`
      ),
      MPD_URL
    )
    const [a, b] = mpd.adaptationSets[0].representations
    expect(mediaUrls(planRepresentation(mpd, a))).toEqual([1, 2, 3].map((n) => `${BASE}a/${n}.m4s`))
    const planB = planRepresentation(mpd, b)
    expect(planB.init).toEqual({ url: `${BASE}b/init.mp4` })
    expect(mediaUrls(planB)).toEqual([7, 8].map((n) => `${BASE}b/${n}.m4s`))
  })

  test('a SegmentList inherits its segments and Initialization from the AdaptationSet', () => {
    const plan = planFirst(
      staticMpd(
        `<AdaptationSet mimeType="video/mp4">
           <SegmentList duration="2"><SegmentURL media="one.m4s"/><SegmentURL media="two.m4s"/></SegmentList>
           <Representation id="r" bandwidth="1">
             <BaseURL>r/</BaseURL>
             <SegmentList><Initialization sourceURL="init.mp4" range="0-10"/></SegmentList>
           </Representation>
         </AdaptationSet>`
      )
    )
    expect(plan.requests).toEqual([
      { url: `${BASE}r/init.mp4`, range: { start: 0, end: 10 } },
      { url: `${BASE}r/one.m4s` },
      { url: `${BASE}r/two.m4s` }
    ])
  })

  test('the lowest level decides the scheme', () => {
    const plan = planFirst(
      staticMpd(
        videoSet(
          '<SegmentTemplate media="$Number$.m4s" duration="1"/>',
          `<Representation id="v" bandwidth="1"><BaseURL>v.mp4</BaseURL>
             <SegmentBase indexRange="10-20"/></Representation>`
        )
      )
    )
    expect(plan.requests).toEqual([{ url: `${BASE}v.mp4` }])
    expect(plan.indexRange).toEqual({ start: 10, end: 20 })
  })
})

/** Video, a trick-mode set, thumbnails, three audio sets and subtitles. */
function selectionMpd({
  frenchPriority = '',
  commentaryRole = 'commentary',
  mainRole = 'main'
} = {}): string {
  const role = (value: string): string =>
    value ? `<Role schemeIdUri="urn:mpeg:dash:role:2011" value="${value}"/>` : ''
  return staticMpd(
    `<SegmentTemplate timescale="1" duration="10" media="$RepresentationID$/$Number$.m4s"/>
     <AdaptationSet id="1" contentType="video" mimeType="video/mp4">
       <Representation id="v480" bandwidth="1200000" width="854" height="480" codecs="avc1.64001e"/>
       <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
       <Representation id="v720" bandwidth="3000000" width="1280" height="720" codecs="avc1.64001f"/>
       <Representation id="v720hi" bandwidth="4000000" width="1280" height="720" codecs="hev1.1.6.L93.B0"/>
     </AdaptationSet>
     <AdaptationSet id="9" contentType="video" mimeType="video/mp4">
       <EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="1"/>
       <Representation id="trick" bandwidth="9000000" width="3840" height="2160"/>
     </AdaptationSet>
     <AdaptationSet id="10" contentType="image" mimeType="image/jpeg">
       <Representation id="thumbs" bandwidth="10000" width="3840" height="2160"/>
     </AdaptationSet>
     <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" lang="en">
       ${role(commentaryRole)}
       <Representation id="en-commentary" bandwidth="96000" codecs="mp4a.40.2"/>
     </AdaptationSet>
     <AdaptationSet id="3" mimeType="audio/mp4" lang="en-US">
       ${role(mainRole)}
       <Representation id="en-64" bandwidth="64000" codecs="mp4a.40.5"/>
       <Representation id="en-128" bandwidth="128000" codecs="mp4a.40.2"/>
     </AdaptationSet>
     <AdaptationSet id="4" contentType="audio" mimeType="audio/mp4" lang="fr" ${frenchPriority}>
       ${role('dub')}
       <Representation id="fr-128" bandwidth="128000" codecs="mp4a.40.2"/>
     </AdaptationSet>
     <AdaptationSet id="5" contentType="text" mimeType="application/mp4" lang="en">
       <Representation id="subs" bandwidth="1000" codecs="stpp"/>
     </AdaptationSet>`
  )
}

test.describe('DASH representation selection @smoke', () => {
  test('the quality list is video only, best first, without trick-mode or thumbnail sets', () => {
    const mpd = parseMpd(selectionMpd(), MPD_URL)
    expect(mpd.adaptationSets.map((set) => set.contentType)).toEqual([
      'video',
      'video',
      'image',
      'audio',
      'audio',
      'audio',
      'text'
    ])
    expect(mpd.adaptationSets[1].trickMode).toBe(true)
    expect(mpd.adaptationSets[4].roles).toEqual(['main'])
    expect(listVideoQualities(mpd)).toEqual([
      {
        id: 'v1080',
        bandwidth: 5000000,
        width: 1920,
        height: 1080,
        codecs: 'avc1.640028',
        mimeType: 'video/mp4'
      },
      {
        id: 'v720hi',
        bandwidth: 4000000,
        width: 1280,
        height: 720,
        codecs: 'hev1.1.6.L93.B0',
        mimeType: 'video/mp4'
      },
      {
        id: 'v720',
        bandwidth: 3000000,
        width: 1280,
        height: 720,
        codecs: 'avc1.64001f',
        mimeType: 'video/mp4'
      },
      {
        id: 'v480',
        bandwidth: 1200000,
        width: 854,
        height: 480,
        codecs: 'avc1.64001e',
        mimeType: 'video/mp4'
      }
    ])
  })

  test('by default: the highest video and the main audio at its best bitrate', () => {
    const mpd = parseMpd(selectionMpd(), MPD_URL)
    const choice = selectRepresentations(mpd)
    expect(choice.video?.id).toBe('v1080')
    expect(choice.audio?.id).toBe('en-128')
    const plans = planSelection(mpd, choice)
    expect(plans.video?.media[0].url).toBe(`${BASE}v1080/1.m4s`)
    expect(plans.audio?.media[2].url).toBe(`${BASE}en-128/3.m4s`)
  })

  test('video by id or by height', () => {
    const mpd = parseMpd(selectionMpd(), MPD_URL)
    const video = (options: Parameters<typeof selectRepresentations>[1]): string | undefined =>
      selectRepresentations(mpd, options).video?.id
    expect(video({ videoId: 'v480' })).toBe('v480')
    expect(video({ height: 1080 })).toBe('v1080')
    expect(video({ height: 720 })).toBe('v720hi')
    expect(video({ height: 1000 })).toBe('v720hi')
    // Nothing that small: the smallest there is.
    expect(video({ height: 100 })).toBe('v480')
    expectRefusal(() => video({ videoId: 'nope' }), 'no-match', /“nope”/)
    expectRefusal(() => video({ videoId: 'trick' }), 'no-match')
  })

  test('audio by language, then selectionPriority, then the main role, then MPD order', () => {
    const audio = (xml: string, audioLanguage?: string): string | undefined =>
      selectRepresentations(parseMpd(xml, MPD_URL), { audioLanguage }).audio?.id
    expect(audio(selectionMpd(), 'fr')).toBe('fr-128')
    expect(audio(selectionMpd(), 'EN')).toBe('en-128')
    // A language the MPD doesn't have falls back to the default.
    expect(audio(selectionMpd(), 'de')).toBe('en-128')
    expect(audio(selectionMpd({ frenchPriority: 'selectionPriority="2"' }))).toBe('fr-128')
    // No set says main: one with no Role counts as main.
    expect(audio(selectionMpd({ mainRole: '', commentaryRole: 'alternate' }))).toBe('en-128')
    // Nothing to tell them apart: the first.
    expect(audio(selectionMpd({ mainRole: '', commentaryRole: '' }))).toBe('en-commentary')
  })

  test('an audio-only MPD selects audio alone; one with neither is refused', () => {
    const audioOnly = staticMpd(
      `<AdaptationSet contentType="audio" mimeType="audio/mp4">
         <SegmentTemplate media="$Number$.m4s" duration="10" timescale="1"/>
         <Representation id="a" bandwidth="64000"/>
       </AdaptationSet>`
    )
    const choice = selectRepresentations(parseMpd(audioOnly, MPD_URL))
    expect(choice.video).toBeUndefined()
    expect(choice.audio?.id).toBe('a')
    expect(planSelection(parseMpd(audioOnly, MPD_URL), choice).video).toBeUndefined()

    const textOnly = staticMpd(
      `<AdaptationSet mimeType="text/vtt"><Representation id="t" bandwidth="1"><BaseURL>t.vtt</BaseURL></Representation></AdaptationSet>`
    )
    expectRefusal(() => selectRepresentations(parseMpd(textOnly, MPD_URL)), 'no-match')
  })

  test('without dimensions, video ranks by bandwidth; audio without lang still selects', () => {
    const mpd = parseMpd(
      staticMpd(
        `<SegmentTemplate media="$RepresentationID$-$Number$.m4s" duration="10" timescale="1"/>
         <AdaptationSet mimeType="video/mp4">
           <Representation id="low" bandwidth="500000"/>
           <Representation id="high" bandwidth="900000"/>
           <Representation id="sized" bandwidth="100000" width="320" height="180"/>
         </AdaptationSet>
         <AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1"/></AdaptationSet>`
      ),
      MPD_URL
    )
    expect(listVideoQualities(mpd).map((quality) => quality.id)).toEqual(['sized', 'high', 'low'])
    // No height to compare counts as fitting under any height.
    expect(selectRepresentations(mpd, { height: 100 }).video?.id).toBe('high')
    expect(selectRepresentations(mpd, { audioLanguage: 'en' }).audio?.id).toBe('a')
  })

  test('content types come from contentType, mimeType or ContentComponent', () => {
    const mpd = parseMpd(
      staticMpd(
        `<SegmentTemplate media="$Number$.m4s" duration="10" timescale="1"/>
         <AdaptationSet><ContentComponent contentType="video"/><Representation id="cc" bandwidth="1"/></AdaptationSet>
         <AdaptationSet><Representation id="mime" bandwidth="1" mimeType="audio/mp4"/></AdaptationSet>
         <AdaptationSet contentType="application"><Representation id="app" bandwidth="1"/></AdaptationSet>
         <AdaptationSet><Representation id="v" bandwidth="1" mimeType="video/mp4"/><Representation id="a" bandwidth="1" mimeType="audio/mp4"/></AdaptationSet>
         <AdaptationSet><Representation id="none" bandwidth="1"/></AdaptationSet>`
      ),
      MPD_URL
    )
    expect(mpd.adaptationSets.map((set) => set.contentType)).toEqual([
      'video',
      'audio',
      'other',
      'other',
      'other'
    ])
    expect(mpd.adaptationSets[3].representations.map((r) => r.contentType)).toEqual([
      'video',
      'audio'
    ])
  })
})

/** Video and audio, with ContentProtection where `where` says. */
function protectedMpd(where: 'period' | 'video-set' | 'v1080' | 'v1080-sub' | 'audio-set'): string {
  const cp = `<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"
                cenc:default_KID="00000000-0000-0000-0000-000000000000"/>
              <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
                <cenc:pssh>AAAAAA==</cenc:pssh>
              </ContentProtection>`
  const at = (place: typeof where): string => (place === where ? cp : '')
  return `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013"
               type="static" mediaPresentationDuration="PT10S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
    <Period>
      ${at('period')}
      <SegmentTemplate timescale="1" duration="5" media="$RepresentationID$/$Number$.m4s"/>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        ${at('video-set')}
        <Representation id="v1080" bandwidth="5000000" width="1920" height="1080">
          ${at('v1080')}<SubRepresentation level="0" bandwidth="1">${at('v1080-sub')}</SubRepresentation>
        </Representation>
        <Representation id="v720" bandwidth="3000000" width="1280" height="720"/>
      </AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/mp4">
        ${at('audio-set')}
        <Representation id="a" bandwidth="128000"/>
      </AdaptationSet>
    </Period>
  </MPD>`
}

test.describe('DASH refusals @smoke', () => {
  test('a live (dynamic) MPD is refused', () => {
    const live = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z"
                       profiles="urn:mpeg:dash:profile:isoff-live:2011"><Period start="PT0S"/></MPD>`
    expectRefusal(() => parseMpd(live, MPD_URL), 'live', /live DASH stream/)
    expectRefusal(() => parseMpd(live.replace('dynamic', 'weird'), MPD_URL), 'malformed')
  })

  test('a protected adaptation set is not listed, selected or planned', () => {
    const mpd = parseMpd(protectedMpd('video-set'), MPD_URL)
    const v1080 = firstRepresentation(mpd)
    expect(mpd.adaptationSets[0].protected).toBe(true)
    expect(v1080.protected).toBe(true)
    expect(listVideoQualities(mpd)).toEqual([])
    expectRefusal(() => selectRepresentations(mpd), 'protected', /DRM/)
    expectRefusal(() => selectRepresentations(mpd, { videoId: 'v720' }), 'protected')
    expectRefusal(() => planRepresentation(mpd, v1080), 'protected')
  })

  for (const where of ['v1080', 'v1080-sub'] as const) {
    test(`a protected representation (${where}) is skipped, and refused when asked for`, () => {
      const mpd = parseMpd(protectedMpd(where), MPD_URL)
      expect(listVideoQualities(mpd).map((quality) => quality.id)).toEqual(['v720'])
      expect(selectRepresentations(mpd).video?.id).toBe('v720')
      expectRefusal(() => selectRepresentations(mpd, { videoId: 'v1080' }), 'protected')
      expectRefusal(() => planRepresentation(mpd, firstRepresentation(mpd)), 'protected')
    })
  }

  test('protection on the period covers everything; protected audio stops the download', () => {
    const everything = parseMpd(protectedMpd('period'), MPD_URL)
    expect(
      everything.adaptationSets.flatMap((set) => set.representations).every((r) => r.protected)
    ).toBe(true)
    expectRefusal(() => selectRepresentations(everything), 'protected')
    expectRefusal(
      () => selectRepresentations(parseMpd(protectedMpd('audio-set'), MPD_URL)),
      'protected'
    )
  })

  test(`more than ${MAX_SEGMENTS} segments is refused, exactly that many is not`, () => {
    const simple = (seconds: number): string =>
      staticMpd(videoSet('<SegmentTemplate media="$Number$.m4s" duration="1" timescale="1"/>'), {
        mpdAttrs: `mediaPresentationDuration="PT${seconds}S"`
      })
    expect(planFirst(simple(MAX_SEGMENTS)).media).toHaveLength(MAX_SEGMENTS)
    expectRefusal(() => planFirst(simple(MAX_SEGMENTS + 1)), 'too-many-segments', /20,000/)

    const timeline = (entries: string): string =>
      staticMpd(
        videoSet(
          `<SegmentTemplate media="$Number$.m4s"><SegmentTimeline>${entries}</SegmentTimeline></SegmentTemplate>`
        )
      )
    expectRefusal(() => planFirst(timeline(`<S d="1" r="${MAX_SEGMENTS}"/>`)), 'too-many-segments')
    // A huge repeat count is refused without listing it.
    expectRefusal(
      () => planFirst(timeline('<S d="1" r="99999999999999999999"/>')),
      'too-many-segments'
    )

    const list = staticMpd(
      videoSet(
        `<SegmentList>${'<SegmentURL media="s.m4s"/>'.repeat(MAX_SEGMENTS + 1)}</SegmentList>`,
        '<Representation id="v" bandwidth="1"/>'
      )
    )
    expectRefusal(() => planFirst(list), 'too-many-segments')
  })

  test('a template that needs a duration the MPD lacks is refused', () => {
    const noDuration = { mpdAttrs: '' }
    expectRefusal(
      () =>
        planFirst(
          staticMpd(videoSet('<SegmentTemplate media="$Number$.m4s" duration="2"/>'), noDuration)
        ),
      'missing-duration',
      /how long/
    )
    expectRefusal(
      () =>
        planFirst(
          staticMpd(
            videoSet(
              '<SegmentTemplate media="$Number$.m4s"><SegmentTimeline><S d="2" r="-1"/></SegmentTimeline></SegmentTemplate>'
            ),
            noDuration
          )
        ),
      'missing-duration'
    )
    // A timeline that doesn't run to the end needs no duration.
    const bounded = staticMpd(
      videoSet(
        '<SegmentTemplate media="$Number$.m4s"><SegmentTimeline><S d="2" r="2"/></SegmentTimeline></SegmentTemplate>'
      ),
      noDuration
    )
    expect(parseMpd(bounded, MPD_URL).durationSeconds).toBeUndefined()
    expect(planFirst(bounded).media).toHaveLength(3)
  })

  test('more than one period is refused; a zero-length period is ignored', () => {
    const periods = (second: string): string =>
      `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S">
         <Period id="main" duration="PT20S">${videoSet('<SegmentTemplate media="$Number$.m4s" duration="10" timescale="1"/>')}</Period>
         ${second}
       </MPD>`
    expectRefusal(
      () => parseMpd(periods('<Period id="ad" duration="PT15S"/>'), MPD_URL),
      'multi-period',
      /2 periods/
    )
    const mpd = parseMpd(periods('<Period id="empty" duration="PT0S"/>'), MPD_URL)
    expect(planRepresentation(mpd, firstRepresentation(mpd)).media).toHaveLength(2)
    expectRefusal(
      () => parseMpd(periods('').replace(/<Period[\s\S]*<\/Period>/, ''), MPD_URL),
      'malformed',
      /no Period/
    )
  })

  test('remote (xlink) elements and other unsupported features are refused', () => {
    const xlink = 'xmlns:xlink="http://www.w3.org/1999/xlink"'
    const cases: [string, RegExp][] = [
      [
        `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${xlink}><Period xlink:href="https://ads.example.com/p.xml"/></MPD>`,
        /remote Period/
      ],
      [staticMpd(`<AdaptationSet ${xlink} xlink:href="remote.xml"/>`), /remote AdaptationSet/],
      [
        staticMpd(
          videoSet(
            '',
            `<Representation id="v" bandwidth="1"><SegmentList ${xlink} xlink:href="list.xml"/></Representation>`
          )
        ),
        /remote SegmentList/
      ],
      [
        staticMpd(videoSet('<SegmentTemplate media="$Number$-$SubNumber$.m4s" duration="1"/>')),
        /SubNumber/
      ],
      [
        staticMpd(
          videoSet(
            '<SegmentTemplate media="$Number$.m4s"><SegmentTimeline><S n="3" d="1"/></SegmentTimeline></SegmentTemplate>'
          )
        ),
        /S@n/
      ],
      [staticMpd(videoSet(''), { head: '<BaseURL>file:///etc/</BaseURL>' }), /isn’t http or https/]
    ]
    for (const [xml, message] of cases) {
      expectRefusal(() => planFirst(xml), 'unsupported', message)
    }
    expectRefusal(() => parseMpd(staticMpd(''), 'file:///tmp/manifest.mpd'), 'unsupported')
  })
})

test.describe('DASH malformed MPDs @smoke', () => {
  test('MPD values the schema does not allow', () => {
    const v = (inner: string, representations?: string): string =>
      staticMpd(videoSet(inner, representations))
    const T = (attrs: string, inner = ''): string =>
      v(`<SegmentTemplate ${attrs}>${inner}</SegmentTemplate>`)
    const timeline = (entries: string): string =>
      T('media="$Number$.m4s"', `<SegmentTimeline>${entries}</SegmentTimeline>`)
    const cases: [name: string, xml: string, message: RegExp][] = [
      ['no id', v('', '<Representation bandwidth="1"/>'), /has no id/],
      ['no bandwidth', v('', '<Representation id="x"/>'), /has no bandwidth/],
      ['bad width', v('', '<Representation id="x" bandwidth="1" width="wide"/>'), /width/],
      [
        'huge bandwidth',
        v('', '<Representation id="x" bandwidth="4294967296"/>'),
        /larger than DASH allows/
      ],
      ['no media', v('', '<Representation id="x" bandwidth="1"/>'), /names no media/],
      ['SegmentBase without media', v('<SegmentBase/>'), /names no media/],
      ['two schemes', v('<SegmentBase/><SegmentList/>'), /more than one way/],
      ['no media template', T('duration="1"'), /no media template/],
      ['timescale 0', T('media="$Number$.m4s" timescale="0"'), /timescale is 0/],
      ['duration 0', T('media="$Number$.m4s" duration="0"'), /duration is 0/],
      ['bad startNumber', T('media="$Number$.m4s" startNumber="-1"'), /startNumber/],
      ['empty timeline', timeline(''), /no entries/],
      ['S without d', timeline('<S t="0"/>'), /no duration/],
      ['S with bad r', timeline('<S d="1" r="many"/>'), /S@r/],
      ['r=-1 then no t', timeline('<S d="1" r="-1"/><S d="1"/>'), /no S@t/],
      [
        'no $Number$',
        T('media="same.m4s" duration="1" timescale="1"'),
        /neither \$Number\$ nor \$Time\$/
      ],
      [
        'endNumber before start',
        T('media="$Number$.m4s" duration="1" startNumber="5" endNumber="2"'),
        /lists no segments/
      ],
      ['unknown identifier', T('media="$Frame$.m4s" duration="1"'), /unknown \$Frame\$/],
      ['unclosed $', T('media="$Number.m4s" duration="1"'), /no closing/],
      ['width on id', T('media="$RepresentationID%02d$.m4s" duration="1"'), /format tag/],
      ['printf without 0', T('media="$Number%5d$.m4s" duration="1"'), /format tag/],
      [
        '$Number$ in init',
        T('media="$Number$.m4s" initialization="init-$Number$.mp4" duration="1"'),
        /can’t use \$Number\$/
      ],
      [
        'open range',
        v('<SegmentList><SegmentURL media="a" mediaRange="500-"/></SegmentList>'),
        /byte range/
      ],
      [
        'reversed range',
        v('<SegmentList><SegmentURL media="a" mediaRange="9-1"/></SegmentList>'),
        /byte range/
      ],
      ['empty list', v('<SegmentList duration="1"/>'), /lists no segments/],
      ['SegmentURL without address', v('<SegmentList><SegmentURL/></SegmentList>'), /no address/],
      [
        'Initialization without address',
        v('<SegmentList><Initialization/><SegmentURL media="a"/></SegmentList>'),
        /no address/
      ],
      [
        'bad address',
        staticMpd(videoSet(''), { head: '<BaseURL>http://[bad</BaseURL>' }),
        /valid address/
      ],
      [
        'month duration',
        staticMpd('', { mpdAttrs: 'mediaPresentationDuration="P1M"' }),
        /years or months/
      ],
      [
        'empty duration',
        staticMpd('', { mpdAttrs: 'mediaPresentationDuration="PT"' }),
        /isn’t a duration/
      ],
      [
        'garbage duration',
        staticMpd('', { mpdAttrs: 'mediaPresentationDuration="10 seconds"' }),
        /isn’t a duration/
      ],
      ['start after end', staticMpd('', { periodAttrs: 'start="PT40S"' }), /starts after/]
    ]
    for (const [name, xml, message] of cases) {
      const error = caught(() => planFirst(xml))
      expect(error.code, name).toBe('malformed')
      expect(error.message, name).toMatch(message)
      expect(error.message, name).toMatch(/^This isn’t a DASH manifest Mergelane can read: /)
    }
  })

  test('XML that is not well-formed is refused', () => {
    const cases: [xml: string, message: RegExp][] = [
      ['', /no root element/],
      ['just text', /text outside/],
      ['<MPD', /isn’t closed properly/],
      ['<MPD>', /never closed/],
      ['<MPD></mpd>', /closed by <\/mpd>/],
      ['</MPD>', /closes nothing/],
      ['<MPD/><MPD/>', /more than one root/],
      ['<MPD/>trailing', /text outside/],
      ['<!DOCTYPE MPD [<!ENTITY x "y">]><MPD/>', /DOCTYPE/],
      ['<MPD>&bogus;</MPD>', /doesn’t start a character or entity reference/],
      ['<MPD>a & b</MPD>', /doesn’t start/],
      ['<MPD>&#0;</MPD>', /refers to a character/],
      ['<MPD>\u0000</MPD>', /U\+0000/],
      ['<MPD>]]></MPD>', /]]>/],
      ['<MPD a="<"/>', /contains “<”/],
      ['<MPD a=1/>', /isn’t quoted/],
      ['<MPD a/>', /has no value/],
      ['<MPD a="1/>', /never closed/],
      ['<MPD a="1"b="2"/>', /isn’t closed properly/],
      ['<MPD a="1" a="2"/>', /attribute a twice/],
      ['<MPD xmlns:p="urn:p" xmlns:q="urn:p" p:a="1" q:a="2"/>', /\{urn:p\}a twice/],
      ['<p:MPD/>', /prefix p, which is never declared/],
      ['<MPD p:a="1"/>', /prefix p, which is never declared/],
      ['<MPD xmlns:p=""/>', /undeclares prefix p/],
      ['<MPD xmlns:xml="urn:other"/>', /reserved namespace prefix/],
      ['<MPD xmlns:xmlns="urn:other"/>', /reserved namespace prefix/],
      ['<MPD><!-- never ends</MPD>', /comment that never ends/],
      ['<?xml version="1.0"', /processing instruction that never ends/],
      ['<![CDATA[x]]><MPD/>', /CDATA section outside/],
      ['<MPD><![CDATA[x</MPD>', /CDATA section that never ends/],
      ['<MPD><1/></MPD>', /tag without a valid name/],
      ['<MPD></MPD x>', /<\/MPD> tag isn’t closed properly/],
      [`${'<a>'.repeat(70)}${'</a>'.repeat(70)}`, /more than 64 deep/],
      ['<Root xmlns="urn:mpeg:dash:schema:mpd:2011"/>', /root element isn’t <MPD>/],
      ['<MPD xmlns="urn:example:other"/>', /root element isn’t <MPD>/]
    ]
    for (const [xml, message] of cases) {
      const error = caught(() => parseMpd(xml, MPD_URL))
      expect(error.code, xml).toBe('malformed')
      expect(error.message, xml).toMatch(message)
    }
    expectRefusal(
      () => parseMpd('<MPD/>'.padEnd(16 * 1024 * 1024 + 1), MPD_URL),
      'malformed',
      /16 MB/
    )
    expectRefusal(
      () => parseMpd(`<MPD>${'<x/>'.repeat(250_001)}</MPD>`, MPD_URL),
      'malformed',
      /250,000 elements/
    )
  })

  test('bytes must be UTF-8', () => {
    expectRefusal(
      () => parseMpd(new Uint8Array([0x3c, 0x4d, 0xff, 0xfe]), MPD_URL),
      'malformed',
      /UTF-8/
    )
    expectRefusal(() => parseMpd('<MPD/>', 'not a url'), 'malformed', /valid address/)
  })
})

test.describe('DASH XML reading @smoke', () => {
  test('bytes, a BOM, CRLF, comments, prefixes and foreign elements', () => {
    const xml = `\ufeff<?xml version="1.0" encoding="UTF-8"?>\r\n<!-- packager v1 -->\r\n<mpd:MPD xmlns:mpd="urn:mpeg:dash:schema:mpd:2011" xmlns:x="urn:example:vendor" mediaPresentationDuration="PT4S">\r\n<x:BaseURL>https://wrong.example.com/</x:BaseURL>\r\n<mpd:Period><?vendor ignore?><mpd:AdaptationSet mimeType="video/mp4"><mpd:SegmentTemplate media="$Number$.m4s" duration="2" timescale="1"/><mpd:Representation id="é" bandwidth="1"/></mpd:AdaptationSet></mpd:Period></mpd:MPD>`
    const fromBytes = planFirst(new TextEncoder().encode(xml))
    expect(mediaUrls(fromBytes)).toEqual([`${BASE}1.m4s`, `${BASE}2.m4s`])
    expect(planFirst(xml)).toEqual(fromBytes)
  })

  test('an MPD with no namespace still reads', () => {
    const plan = planFirst(
      `<MPD type="static" mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4">
         <SegmentTemplate media="$Number$.m4s" duration="1" timescale="1"/>
         <Representation id="v" bandwidth="1"/>
       </AdaptationSet></Period></MPD>`
    )
    expect(plan.media).toHaveLength(2)
  })

  test('attributes are normalized and namespaced attributes keyed by namespace', () => {
    const root = parseXml(
      `<MPD xmlns="urn:a" xmlns:b="urn:b" plain="a\tb\nc" b:x="1" xml:lang="en" spaced = 'x &amp; &#x41;&#10;' chars="&#9;&#xD;&#xE000;&#x10000;&#xFFFD;"><Child xmlns="">text <![CDATA[<raw>]]> &lt;</Child></MPD>`
    )
    expect(root.ns).toBe('urn:a')
    expect(root.attrs.get('plain')).toBe('a b c')
    expect(root.attrs.get('{urn:b}x')).toBe('1')
    expect(root.attrs.get('{http://www.w3.org/XML/1998/namespace}lang')).toBe('en')
    expect(root.attrs.get('spaced')).toBe('x & A\n')
    // Every range of XML's Char production, by reference.
    expect(root.attrs.get('chars')).toBe('\t\r\ue000\u{10000}\ufffd')
    for (const outside of ['&#xD800;', '&#xFFFE;', '&#x110000;', '&#8;']) {
      expectRefusal(() => parseXml(`<a b="${outside}"/>`), 'malformed', /refers to a character/)
    }
    expect(root.attrs.has('xmlns')).toBe(false)
    expect(root.children[0]).toMatchObject({ ns: '', name: 'Child', text: 'text <raw> <' })
  })
})
