import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import { find, given, scene, tap } from 'foldkit/scene'
import type { HtmlBuilder } from 'foldkit/html'
import { Progress } from '../src/components/ui/progress'

describe('progress', () => {
  it('fills from the left by the displayed percentage', () => {
    scene(
      {
        update: (model: number) => ({ model }),
        view: (_model: number, h: HtmlBuilder<never>) => Progress({ value: 40 }, h),
      },
      given(0),
      tap(({ html }) => {
        const indicator = find(html, '[data-slot="progress-indicator"]')
        expect(Option.map(indicator, (node) => node.data?.style?.width)).toEqual(Option.some('40%'))
      }),
    )
  })
})
