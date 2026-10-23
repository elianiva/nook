import { Schema as S } from 'effect'

const storyWordIds = ['linger', 'canopy'] as const
type StoryWord = (typeof storyWordIds)[number]

/** One passage in the feed, written or generated, with the word it teaches. */
export const StorySchema = S.Struct({
  id: S.String,
  word: S.String,
  reading: S.String,
  meaning: S.String,
  title: S.String,
  tag: S.String,
  caption: S.String,
  passage: S.String,
  translation: S.String,
})
export type Story = typeof StorySchema.Type

type StoryPassage = Readonly<{
  title: string
  tag: string
  before: string
  after: string
  caption: string
  translation: string
}>

type StoryFeed = Readonly<{
  word: string
  reading: string
  meaning: string
  pickerMeaning: string
  stories: ReadonlyArray<StoryPassage>
}>

const storyFeeds: Record<StoryWord, StoryFeed> = {
  linger: {
    word: '余韻',
    reading: 'よいん',
    meaning: 'a feeling that lingers',
    pickerMeaning: 'lingering feeling',
    stories: [
      {
        title: 'The station after rain',
        tag: 'A QUIET EVENING',
        before: '雨がやんだ駅のホーム。最後の電車が去ったあとも、線路の向こうに音の',
        after: 'が残っていた。',
        caption: 'Some goodbyes take their time.',
        translation:
          'On the platform after the rain, the last train disappeared. Still, the echo of its sound lingered beyond the tracks.',
      },
      {
        title: 'A song from upstairs',
        tag: 'THROUGH THE WALL',
        before: 'となりの部屋から、知らない歌が聞こえる。窓を閉めても、そのメロディーの',
        after: 'が夜の中に浮かんでいた。',
        caption: 'A stranger’s song, briefly yours.',
        translation:
          'A song I didn’t know drifted from the next room. Even with the window shut, its melody lingered in the night.',
      },
      {
        title: 'The last sip',
        tag: 'AFTER THE CAFÉ',
        before: '冷めたコーヒーを飲み干す。カップの底に、さっきまで話していた人の笑顔の',
        after: 'がまだあった。',
        caption: 'A little warmth after the conversation.',
        translation:
          'I finished the coffee, now cold. At the bottom of the cup, the smile of the person I’d just spoken with still remained.',
      },
      {
        title: 'Paper lanterns',
        tag: 'FESTIVAL ENDS',
        before: '祭りの灯りがひとつずつ消えていく。帰り道、提灯の赤い光の',
        after: 'が目の奥に残った。',
        caption: 'The night keeps one last light.',
        translation:
          'The festival lights went out one by one. On the way home, the afterimage of the red lanterns stayed behind my eyes.',
      },
      {
        title: 'A door left open',
        tag: 'SUNDAY MORNING',
        before: '祖母の部屋のドアは、いつも少しだけ開いていた。いなくなった今も、その習慣の',
        after: 'が廊下に続いている。',
        caption: 'Love can leave a door ajar.',
        translation:
          'My grandmother’s door was always left slightly open. Even now that she’s gone, that small habit seems to linger down the hall.',
      },
      {
        title: 'The empty gallery',
        tag: 'LAST VISITOR',
        before: '誰もいない美術館で、絵の前に立ち止まる。筆の跡から、描いた人のためらいの',
        after: 'が伝わってきた。',
        caption: 'A pause left inside the paint.',
        translation:
          'Alone in the gallery, I stopped in front of a painting. From the brushstrokes, I could feel the lingering trace of the artist’s hesitation.',
      },
      {
        title: 'Snow at the bus stop',
        tag: 'FIRST SNOW',
        before: 'バスが角を曲がり、雪だけが静かに降り続ける。エンジンの音の',
        after: 'が消えるまで、私は手袋を外さなかった。',
        caption: 'Waiting for the world to go quiet.',
        translation:
          'The bus turned the corner, and snow kept falling. I left my gloves on until the echo of the engine had faded.',
      },
      {
        title: 'One more page',
        tag: 'PAST MIDNIGHT',
        before: '本を閉じたのに、物語の最後の一文が頭から離れない。眠る前の部屋に、その言葉の',
        after: 'だけが灯っていた。',
        caption: 'A story can keep you company after.',
        translation:
          'I closed the book, but its final sentence stayed with me. Before sleep, that last line was the only light in the room.',
      },
      {
        title: 'A wave from the pier',
        tag: 'LOW TIDE',
        before: '船はもう見えない。それでも、岸壁に立つ友だちの手を振る姿の',
        after: 'が、海の向こうに揺れていた。',
        caption: 'Some waves travel farther than boats.',
        translation:
          'The boat was already out of sight. Still, the lingering image of my friend waving from the pier wavered across the water.',
      },
      {
        title: 'After the applause',
        tag: 'LIGHTS UP',
        before: '幕が下り、拍手が少しずつ静かになった。舞台に残る足音の',
        after: 'を、誰も急いで壊そうとはしなかった。',
        caption: 'Let the ending have its moment.',
        translation:
          'The curtain fell, and the applause slowly softened. Nobody seemed in a hurry to break the lingering footsteps onstage.',
      },
    ],
  },
  canopy: {
    word: '木漏れ日',
    reading: 'こもれび',
    meaning: 'sunlight filtering through leaves',
    pickerMeaning: 'sunlight through leaves',
    stories: [
      {
        title: 'The path behind school',
        tag: 'AFTER CLASS',
        before: '近道の森を歩く。葉っぱのすき間から落ちる',
        after: 'が、地面に小さな地図を描いていた。',
        caption: 'A path that only the light can read.',
        translation:
          'I took the shortcut through the woods. Sunlight filtering through the leaves drew a tiny map on the ground.',
      },
      {
        title: 'A cat’s afternoon',
        tag: 'SLEEPY WINDOW',
        before: '猫は窓辺で目を閉じた。背中に当たる',
        after: 'が動くたび、しっぽも少しだけ揺れた。',
        caption: 'The smallest afternoon appointment.',
        translation:
          'The cat closed its eyes by the window. Each time the sunlight through the leaves shifted across its back, its tail moved a little.',
      },
      {
        title: 'The old camera',
        tag: 'A WALK WITH GRANDPA',
        before: '祖父は古いカメラを構えた。撮りたかったのは花ではなく、道に揺れる',
        after: 'だった。',
        caption: 'Some pictures are mostly made of light.',
        translation:
          'My grandfather raised his old camera. It wasn’t the flowers he wanted to photograph, but the dappled sunlight trembling on the path.',
      },
      {
        title: 'The picnic blanket',
        tag: 'LATE SPRING',
        before: '木の下にシートを広げる。サンドイッチの上を',
        after: 'が通り過ぎて、チーズが一瞬だけ金色になった。',
        caption: 'Lunch served with a little sun.',
        translation:
          'We spread a blanket under the tree. Sunlight slipped across the sandwich, turning the cheese gold for just a moment.',
      },
      {
        title: 'The hidden bench',
        tag: 'A QUIET CORNER',
        before: '公園の奥に、小さなベンチがある。座ると',
        after: 'が肩に触れて、ここに来た理由を忘れさせた。',
        caption: 'A place where nothing needs fixing.',
        translation:
          'There’s a small bench at the back of the park. When I sat down, the sunlight through the leaves touched my shoulder and made me forget why I came.',
      },
      {
        title: 'Dandelion seeds',
        tag: 'WINDLESS DAY',
        before: '綿毛がひとつ、',
        after: 'の中をゆっくり漂う。子どもは息を止めて、その行き先を見守った。',
        caption: 'Following a tiny, bright possibility.',
        translation:
          'A dandelion seed drifted slowly through the dappled sunlight. The child held their breath and watched where it would go.',
      },
      {
        title: 'The shrine steps',
        tag: 'ON THE WAY HOME',
        before: '神社の石段を上る。鳥居の向こうで',
        after: 'が揺れて、町の音まで遠くなった気がした。',
        caption: 'A few steps out of the everyday.',
        translation:
          'I climbed the stone steps to the shrine. Dappled sunlight trembled beyond the gate, and the sounds of town seemed to drift away.',
      },
      {
        title: 'A green umbrella',
        tag: 'AFTER THE SHOWER',
        before: '雨のあと、葉っぱから水が落ちる。そこに差し込む',
        after: 'が、小さな水滴をひとつずつ光らせた。',
        caption: 'The trees kept a little of the rain.',
        translation:
          'After the rain, water fell from the leaves. Sunlight filtering through them lit each droplet, one by one.',
      },
      {
        title: 'The bookshop garden',
        tag: 'HIDDEN IN THE CITY',
        before: '古本屋の裏に、手入れされていない庭がある。ページをめくるたび、',
        after: 'が本の上をゆっくり動いた。',
        caption: 'A quiet chapter in the middle of town.',
        translation:
          'Behind the used-book shop was an untended garden. Each time I turned a page, dappled light moved slowly across the book.',
      },
      {
        title: 'The walking club',
        tag: 'SUNDAY ROUTE',
        before: 'みんなは先へ行ってしまった。私は',
        after: 'の下で立ち止まり、木の名前をひとつ覚えてから追いかけた。',
        caption: 'There’s no prize for arriving first.',
        translation:
          'Everyone walked ahead. I stopped beneath the dappled light, learned the name of one tree, then caught up.',
      },
    ],
  },
}

/** The built-in passages the feed starts with, before the Learner generates their own. */
export const sampleStories: ReadonlyArray<Story> = storyWordIds.flatMap((id) => {
  const feed = storyFeeds[id]
  return feed.stories.map((story, index) => ({
    id: `${id}-${index + 1}`,
    word: feed.word,
    reading: feed.reading,
    meaning: feed.meaning,
    title: story.title,
    tag: story.tag,
    caption: story.caption,
    passage: `${story.before}${feed.word}${story.after}`,
    translation: story.translation,
  }))
})
