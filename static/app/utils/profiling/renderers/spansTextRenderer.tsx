import {mat3} from 'gl-matrix';

import {
  ELLIPSIS,
  findRangeBinarySearch,
  getContext,
  Rect,
  resizeCanvasToDisplaySize,
  trimTextCenter,
} from 'sentry/utils/profiling/gl/utils';
import {TextRenderer} from 'sentry/utils/profiling/renderers/textRenderer';
import {SpanChart, SpanChartNode} from 'sentry/utils/profiling/spanChart';

import {FlamegraphTheme} from '../flamegraph/flamegraphTheme';

class SpansTextRenderer extends TextRenderer {
  spanChart: SpanChart;

  constructor(canvas: HTMLCanvasElement, theme: FlamegraphTheme, spanChart: SpanChart) {
    super(canvas, theme);
    this.canvas = canvas;
    this.theme = theme;
    this.spanChart = spanChart;

    this.textCache = {};
    this.context = getContext(canvas, '2d');
    resizeCanvasToDisplaySize(canvas);
  }

  draw(
    configView: Rect,
    configViewToPhysicalSpace: mat3
    // flamegraphSearchResults: FlamegraphSearch['results']
  ): void {
    // Make sure we set font size before we measure text for the first draw
    const FONT_SIZE = this.theme.SIZES.SPANS_FONT_SIZE * window.devicePixelRatio;
    this.context.font = `${FONT_SIZE}px ${this.theme.FONTS.FRAME_FONT}`;
    this.context.textBaseline = 'alphabetic';

    this.maybeInvalidateCache();

    const MIN_WIDTH = this.measureAndCacheText(ELLIPSIS).width;
    const SIDE_PADDING = 2 * this.theme.SIZES.BAR_PADDING * window.devicePixelRatio;
    const HALF_SIDE_PADDING = SIDE_PADDING / 2;
    const BASELINE_OFFSET =
      (this.theme.SIZES.SPANS_BAR_HEIGHT - this.theme.SIZES.SPANS_FONT_SIZE / 2) *
      window.devicePixelRatio;

    const TOP_BOUNDARY = configView.top - 1;
    const BOTTOM_BOUNDARY = configView.bottom + 1;

    // We start by iterating over root spans, so we draw the call stacks top-down.
    // This allows us to do a couple optimizations that improve our best case performance.
    // 1. We can skip drawing the entire tree if the root frame is not visible
    // 2. We can skip drawing and
    const spans: SpanChartNode[] = [...this.spanChart.root.children];

    while (spans.length > 0) {
      const span = spans.pop()!;

      // Check if our rect overlaps with the current viewport and skip rendering if it does not.
      if (span.end < configView.left || span.start > configView.right) {
        continue;
      }

      if (span.depth > BOTTOM_BOUNDARY) {
        continue;
      }

      // We pin the start and end of the span, so scrolling around keeps text pinned to the left or right side of the viewport
      const pinnedStart = Math.max(span.start, configView.left);
      const pinnedEnd = Math.min(span.end, configView.right);

      // Transform span to physical space coordinates. This does the same operation as
      // Rect.transformRect, but without allocating a new Rect object.
      const rectWidth =
        (pinnedEnd - pinnedStart) * configViewToPhysicalSpace[0] +
        configViewToPhysicalSpace[3];

      // Since the text is not exactly aligned to the left/right bounds of the span, we need to subtract the padding
      // from the total width, so that we can truncate the center of the text accurately.
      const paddedRectangleWidth = rectWidth - SIDE_PADDING;

      // Since children of a span cannot be wider than the span itself, we can exit early and discard the entire subtree
      if (paddedRectangleWidth <= MIN_WIDTH) {
        continue;
      }

      for (let i = 0; i < span.children.length; i++) {
        spans.push(span.children[i]);
      }

      // If a span is lower than the top, we can skip drawing its text, however
      // we can only do so after we have pushed it's children into the queue or else
      // those children will never be drawn and the entire sub-tree will be skipped.
      if (span.depth < TOP_BOUNDARY) {
        continue;
      }

      // Transform span to physical space coordinates. This does the same operation as
      // Rect.transformRect, but without allocating a new Rect object.
      const rectHeight =
        (pinnedEnd - pinnedStart) * configViewToPhysicalSpace[1] +
        configViewToPhysicalSpace[4];
      const rectX =
        pinnedStart * configViewToPhysicalSpace[0] +
        span.depth * configViewToPhysicalSpace[3] +
        configViewToPhysicalSpace[6];
      const rectY =
        pinnedStart * configViewToPhysicalSpace[1] +
        span.depth * configViewToPhysicalSpace[4] +
        configViewToPhysicalSpace[7];

      // We want to draw the text in the vertical center of the span, so we substract half the height of the text.
      // Since the origin of the rect in the inverted view is also inverted, we need to add the height.
      const x = rectX + (rectWidth < 0 ? rectWidth : 0) + HALF_SIDE_PADDING;
      const y = rectY + (rectHeight < 0 ? rectHeight : 0) + BASELINE_OFFSET;

      const text = span.node.span.op
        ? span.node.span.op + '' + (span.node.span.description || '')
        : span.node.span.description || '';

      const trim = trimTextCenter(
        text,
        findRangeBinarySearch(
          {low: 0, high: paddedRectangleWidth},
          n => this.measureAndCacheText(text.substring(0, n)).width,
          paddedRectangleWidth
        )[0]
      );

      this.context.fillStyle = this.theme.COLORS.LABEL_FONT_COLOR;
      this.context.fillText(trim.text, x, y);
    }
  }
}

export {SpansTextRenderer};
