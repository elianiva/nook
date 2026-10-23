import { Option } from 'effect'
import { GenerateStories, SetStorySaved } from '../api-commands'
import { defineHandlers } from './handlers'

export const storyFeedHandlers = defineHandlers((model) => {
  const feed = model.storyFeed
  const withFeed = (changes: Partial<typeof feed>) => ({
    ...model,
    storyFeed: { ...feed, ...changes },
  })
  const withSaved = (storyId: string, saved: boolean) =>
    withFeed({
      savedStoryIds: [
        ...feed.savedStoryIds.filter((id) => id !== storyId),
        ...(saved ? [storyId] : []),
      ],
    })
  return {
    EditedStoryWord: ({ value }) => ({ model: withFeed({ word: value }) }),

    SubmittedStoryGeneration: () => {
      const word = feed.word.trim()
      if (feed.generating) return { model }
      if (word === '') {
        return {
          model: withFeed({
            generationError: Option.some('Enter a Japanese word.'),
          }),
        }
      }
      return {
        model: withFeed({ generating: true, generationError: Option.none() }),
        commands: [GenerateStories({ word })],
      }
    },

    GotStories: ({ stories }) => ({
      model: withFeed({ stories: [...feed.stories, ...stories], generating: false }),
    }),

    FailedStoryGeneration: ({ error }) => ({
      model: withFeed({ generating: false, generationError: Option.some(error) }),
    }),

    // The feed flips at once; the server's answer settles it, so a failed save
    // or a refused removal puts the button back.
    ToggledStorySave: ({ storyId }) => {
      const story = feed.stories.find((candidate) => candidate.id === storyId)
      if (story === undefined) return { model }
      const saved = !feed.savedStoryIds.includes(storyId)
      return {
        model: withSaved(storyId, saved),
        commands: [
          SetStorySaved({
            story: {
              storyId,
              word: story.word,
              reading: story.reading,
              meaning: story.meaning,
              passage: story.passage,
              translation: story.translation,
            },
            saved,
          }),
        ],
      }
    },

    SettledStorySave: ({ storyId, saved }) => ({ model: withSaved(storyId, saved) }),
  }
})
