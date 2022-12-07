import {Component, createContext, createRef} from 'react';
import throttle from 'lodash/throttle';

import {
  clamp,
  rectOfContent,
  toPercent,
} from 'sentry/components/performance/waterfall/utils';
import getDisplayName from 'sentry/utils/getDisplayName';
import {setBodyUserSelect, UserSelectValues} from 'sentry/utils/userselect';

import {DragManagerChildrenProps} from './dragManager';
import {SpanBar} from './spanBar';
import {SpansInViewMap, spanTargetHash} from './utils';

export type ScrollbarManagerChildrenProps = {
  generateContentSpanBarRef: () => (instance: HTMLDivElement | null) => void;
  markSpanInView: (spanId: string, treeDepth: number) => void;
  markSpanOutOfView: (spanId: string) => void;
  onDragStart: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
  onScroll: () => void;
  onWheel: (deltaX: number) => void;
  scrollBarAreaRef: React.RefObject<HTMLDivElement>;
  storeSpanBar: (spanBar: SpanBar) => void;
  updateScrollState: () => void;
  virtualScrollbarRef: React.RefObject<HTMLDivElement>;
};

const ScrollbarManagerContext = createContext<ScrollbarManagerChildrenProps>({
  generateContentSpanBarRef: () => () => undefined,
  virtualScrollbarRef: createRef<HTMLDivElement>(),
  scrollBarAreaRef: createRef<HTMLDivElement>(),
  onDragStart: () => {},
  onScroll: () => {},
  onWheel: () => {},
  updateScrollState: () => {},
  markSpanOutOfView: () => {},
  markSpanInView: () => {},
  storeSpanBar: () => {},
});

const selectRefs = (
  refs: Set<HTMLDivElement> | React.RefObject<HTMLDivElement>,
  transform: (element: HTMLDivElement) => void
) => {
  if (!(refs instanceof Set)) {
    if (refs.current) {
      transform(refs.current);
    }

    return;
  }

  refs.forEach(element => {
    if (document.body.contains(element)) {
      transform(element);
    }
  });
};

// simple linear interpolation between start and end such that needle is between [0, 1]
const lerp = (start: number, end: number, needle: number) => {
  return start + needle * (end - start);
};

type Props = {
  children: React.ReactNode;
  dividerPosition: number;
  // this is the DOM element where the drag events occur. it's also the reference point
  // for calculating the relative mouse x coordinate.
  interactiveLayerRef: React.RefObject<HTMLDivElement>;

  dragProps?: DragManagerChildrenProps;
  isEmbedded?: boolean;
};

type State = {
  maxContentWidth: number | undefined;
};

export class Provider extends Component<Props, State> {
  state: State = {
    maxContentWidth: undefined,
  };

  componentDidMount() {
    // React will guarantee that refs are set before componentDidMount() is called;
    // but only for DOM elements that actually got rendered

    this.initializeScrollState();

    const anchoredSpanHash = window.location.hash.split('#')[1];

    // If the user is opening the span tree with an anchor link provided, we need to continuously reconnect the observers.
    // This is because we need to wait for the window to scroll to the anchored span first, or there will be inconsistencies in
    // the spans that are actually considered in the view. The IntersectionObserver API cannot keep up with the speed
    // at which the window scrolls to the anchored span, and will be unable to register the spans that went out of the view.
    // We stop reconnecting the observers once we've confirmed that the anchored span is in the view (or after a timeout).

    if (anchoredSpanHash) {
      // We cannot assume the root is in view to start off, if there is an anchored span
      this.spansInView.isRootSpanInView = false;
      const anchoredSpanId = window.location.hash.replace(spanTargetHash(''), '');

      // Continuously check to see if the anchored span is in the view
      this.anchorCheckInterval = setInterval(() => {
        this.spanBars.forEach(spanBar => spanBar.connectObservers());

        if (this.spansInView.has(anchoredSpanId)) {
          clearInterval(this.anchorCheckInterval!);
          this.anchorCheckInterval = null;
        }
      }, 50);

      // If the anchored span is never found in the view (malformed ID), cancel the interval
      setTimeout(() => {
        if (this.anchorCheckInterval) {
          clearInterval(this.anchorCheckInterval);
          this.anchorCheckInterval = null;
        }
      }, 1000);

      return;
    }

    this.spanBars.forEach(spanBar => spanBar.connectObservers());
  }

  componentDidUpdate(prevProps: Props) {
    // Re-initialize the scroll state whenever:
    // - the window was selected via the minimap or,
    // - the divider was re-positioned.

    const dividerPositionChanged =
      this.props.dividerPosition !== prevProps.dividerPosition;

    const viewWindowChanged =
      prevProps.dragProps &&
      this.props.dragProps &&
      (prevProps.dragProps.viewWindowStart !== this.props.dragProps.viewWindowStart ||
        prevProps.dragProps.viewWindowEnd !== this.props.dragProps.viewWindowEnd);

    if (dividerPositionChanged || viewWindowChanged) {
      this.initializeScrollState();
    }
  }

  componentWillUnmount() {
    this.cleanUpListeners();
    if (this.anchorCheckInterval) {
      clearInterval(this.anchorCheckInterval);
    }
  }

  anchorCheckInterval: NodeJS.Timer | null = null;
  contentSpanBar: Set<HTMLDivElement> = new Set();
  virtualScrollbar: React.RefObject<HTMLDivElement> = createRef<HTMLDivElement>();
  scrollBarArea: React.RefObject<HTMLDivElement> = createRef<HTMLDivElement>();
  isDragging: boolean = false;
  isWheeling: boolean = false;
  wheelTimeout: NodeJS.Timeout | null = null;
  animationTimeout: NodeJS.Timeout | null = null;
  previousUserSelect: UserSelectValues | null = null;
  spansInView: SpansInViewMap = new SpansInViewMap(!this.props.isEmbedded);
  spanBars: SpanBar[] = [];

  getReferenceSpanBar() {
    for (const currentSpanBar of this.contentSpanBar) {
      const isHidden = currentSpanBar.offsetParent === null;
      if (!document.body.contains(currentSpanBar) || isHidden) {
        continue;
      }
      return currentSpanBar;
    }

    return undefined;
  }

  initializeScrollState = () => {
    if (this.contentSpanBar.size === 0 || !this.hasInteractiveLayer()) {
      return;
    }

    // reset all span bar content containers to their natural widths
    selectRefs(this.contentSpanBar, (spanBarDOM: HTMLDivElement) => {
      spanBarDOM.style.removeProperty('width');
      spanBarDOM.style.removeProperty('max-width');
      spanBarDOM.style.removeProperty('overflow');
      spanBarDOM.style.removeProperty('transform');
    });

    // Find the maximum content width. We set each content spanbar to be this maximum width,
    // such that all content spanbar widths are uniform.
    const maxContentWidth = Array.from(this.contentSpanBar).reduce(
      (currentMaxWidth, currentSpanBar) => {
        const isHidden = currentSpanBar.offsetParent === null;
        if (!document.body.contains(currentSpanBar) || isHidden) {
          return currentMaxWidth;
        }

        const maybeMaxWidth = currentSpanBar.scrollWidth;

        if (maybeMaxWidth > currentMaxWidth) {
          return maybeMaxWidth;
        }

        return currentMaxWidth;
      },
      0
    );

    selectRefs(this.contentSpanBar, (spanBarDOM: HTMLDivElement) => {
      spanBarDOM.style.width = `${maxContentWidth}px`;
      spanBarDOM.style.maxWidth = `${maxContentWidth}px`;
      spanBarDOM.style.overflow = 'hidden';
    });

    // set inner width of scrollbar area
    selectRefs(this.scrollBarArea, (scrollBarArea: HTMLDivElement) => {
      scrollBarArea.style.width = `${maxContentWidth}px`;
      scrollBarArea.style.maxWidth = `${maxContentWidth}px`;
    });

    selectRefs(
      this.props.interactiveLayerRef,
      (interactiveLayerRefDOM: HTMLDivElement) => {
        interactiveLayerRefDOM.scrollLeft = 0;
      }
    );

    const spanBarDOM = this.getReferenceSpanBar();

    if (spanBarDOM) {
      this.syncVirtualScrollbar(spanBarDOM);
    }

    const left = this.spansInView.getScrollVal();
    this.performScroll(left);
  };

  syncVirtualScrollbar = (spanBar: HTMLDivElement) => {
    // sync the virtual scrollbar's width to the spanBar's width

    if (!this.virtualScrollbar.current || !this.hasInteractiveLayer()) {
      return;
    }

    const virtualScrollbarDOM = this.virtualScrollbar.current;

    const maxContentWidth = spanBar.getBoundingClientRect().width;

    if (maxContentWidth === undefined || maxContentWidth <= 0) {
      virtualScrollbarDOM.style.width = '0';
      return;
    }

    const visibleWidth =
      this.props.interactiveLayerRef.current!.getBoundingClientRect().width;

    // This is the width of the content not visible.
    const maxScrollDistance = maxContentWidth - visibleWidth;

    const virtualScrollbarWidth = visibleWidth / (visibleWidth + maxScrollDistance);

    if (virtualScrollbarWidth >= 1) {
      virtualScrollbarDOM.style.width = '0';
      return;
    }

    virtualScrollbarDOM.style.width = `max(50px, ${toPercent(virtualScrollbarWidth)})`;

    virtualScrollbarDOM.style.removeProperty('transform');
  };

  generateContentSpanBarRef = () => {
    let previousInstance: HTMLDivElement | null = null;

    const addContentSpanBarRef = (instance: HTMLDivElement | null) => {
      if (previousInstance) {
        this.contentSpanBar.delete(previousInstance);
        previousInstance = null;
      }

      if (instance) {
        this.contentSpanBar.add(instance);
        previousInstance = instance;
      }
    };

    return addContentSpanBarRef;
  };

  hasInteractiveLayer = (): boolean => !!this.props.interactiveLayerRef.current;
  initialMouseClickX: number | undefined = undefined;

  performScroll = (scrollLeft: number, isAnimated?: boolean) => {
    const {interactiveLayerRef} = this.props;
    if (!interactiveLayerRef.current) {
      return;
    }

    if (isAnimated) {
      this.startAnimation();
    }

    const interactiveLayerRefDOM = interactiveLayerRef.current;
    const interactiveLayerRect = interactiveLayerRefDOM.getBoundingClientRect();
    interactiveLayerRefDOM.scrollLeft = scrollLeft;

    // Update scroll position of the virtual scroll bar
    selectRefs(this.scrollBarArea, (scrollBarAreaDOM: HTMLDivElement) => {
      selectRefs(this.virtualScrollbar, (virtualScrollbarDOM: HTMLDivElement) => {
        const scrollBarAreaRect = scrollBarAreaDOM.getBoundingClientRect();
        const virtualScrollbarPosition = scrollLeft / scrollBarAreaRect.width;

        const virtualScrollBarRect = rectOfContent(virtualScrollbarDOM);
        const maxVirtualScrollableArea =
          1 - virtualScrollBarRect.width / interactiveLayerRect.width;

        const virtualLeft =
          clamp(virtualScrollbarPosition, 0, maxVirtualScrollableArea) *
          interactiveLayerRect.width;

        virtualScrollbarDOM.style.transform = `translateX(${virtualLeft}px)`;
        virtualScrollbarDOM.style.transformOrigin = 'left';
      });
    });

    // Update scroll positions of all the span bars
    selectRefs(this.contentSpanBar, (spanBarDOM: HTMLDivElement) => {
      const left = -scrollLeft;

      spanBarDOM.style.transform = `translateX(${left}px)`;
      spanBarDOM.style.transformOrigin = 'left';
    });
  };

  // Throttle the scroll function to prevent jankiness in the auto-adjust animations when scrolling fast
  throttledScroll = throttle(this.performScroll, 300, {trailing: true});

  onWheel = (deltaX: number) => {
    if (this.isDragging || !this.hasInteractiveLayer()) {
      return;
    }

    this.disableAnimation();

    // Setting this here is necessary, since updating the virtual scrollbar position will also trigger the onScroll function
    this.isWheeling = true;

    if (this.wheelTimeout) {
      clearTimeout(this.wheelTimeout);
    }

    this.wheelTimeout = setTimeout(() => {
      this.isWheeling = false;
      this.wheelTimeout = null;
    }, 200);

    const interactiveLayerRefDOM = this.props.interactiveLayerRef.current!;

    const maxScrollLeft =
      interactiveLayerRefDOM.scrollWidth - interactiveLayerRefDOM.clientWidth;

    const scrollLeft = clamp(
      interactiveLayerRefDOM.scrollLeft + deltaX,
      0,
      maxScrollLeft
    );

    this.performScroll(scrollLeft);
  };

  onScroll = () => {
    if (this.isDragging || this.isWheeling || !this.hasInteractiveLayer()) {
      return;
    }

    const interactiveLayerRefDOM = this.props.interactiveLayerRef.current!;
    const scrollLeft = interactiveLayerRefDOM.scrollLeft;

    this.performScroll(scrollLeft);
  };

  onDragStart = (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    if (
      this.isDragging ||
      event.type !== 'mousedown' ||
      !this.hasInteractiveLayer() ||
      !this.virtualScrollbar.current
    ) {
      return;
    }

    event.stopPropagation();

    const virtualScrollbarRect = rectOfContent(this.virtualScrollbar.current);

    // get initial x-coordinate of the mouse click on the virtual scrollbar
    this.initialMouseClickX = Math.abs(event.clientX - virtualScrollbarRect.x);

    // prevent the user from selecting things outside the minimap when dragging
    // the mouse cursor inside the minimap
    this.previousUserSelect = setBodyUserSelect({
      userSelect: 'none',
      MozUserSelect: 'none',
      msUserSelect: 'none',
      webkitUserSelect: 'none',
    });

    // attach event listeners so that the mouse cursor does not select text during a drag
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragEnd);

    // indicate drag has begun

    this.isDragging = true;

    selectRefs(this.virtualScrollbar, scrollbarDOM => {
      scrollbarDOM.classList.add('dragging');
      document.body.style.setProperty('cursor', 'grabbing', 'important');
    });
  };

  onDragMove = (event: MouseEvent) => {
    if (
      !this.isDragging ||
      event.type !== 'mousemove' ||
      !this.hasInteractiveLayer() ||
      !this.virtualScrollbar.current ||
      this.initialMouseClickX === undefined
    ) {
      return;
    }

    const virtualScrollbarDOM = this.virtualScrollbar.current;

    const interactiveLayerRect =
      this.props.interactiveLayerRef.current!.getBoundingClientRect();

    const virtualScrollBarRect = rectOfContent(virtualScrollbarDOM);

    // Mouse x-coordinate relative to the interactive layer's left side
    const localDragX = event.pageX - interactiveLayerRect.x;
    // The drag movement with respect to the interactive layer's width.
    const rawMouseX = (localDragX - this.initialMouseClickX) / interactiveLayerRect.width;

    const maxVirtualScrollableArea =
      1 - virtualScrollBarRect.width / interactiveLayerRect.width;

    // clamp rawMouseX to be within [0, 1]
    const virtualScrollbarPosition = clamp(rawMouseX, 0, 1);

    const virtualLeft =
      clamp(virtualScrollbarPosition, 0, maxVirtualScrollableArea) *
      interactiveLayerRect.width;

    virtualScrollbarDOM.style.transform = `translate3d(${virtualLeft}px, 0, 0)`;
    virtualScrollbarDOM.style.transformOrigin = 'left';

    const virtualScrollPercentage = clamp(rawMouseX / maxVirtualScrollableArea, 0, 1);

    // Update scroll positions of all the span bars

    selectRefs(this.contentSpanBar, (spanBarDOM: HTMLDivElement) => {
      const maxScrollDistance =
        spanBarDOM.getBoundingClientRect().width - interactiveLayerRect.width;

      const left = -lerp(0, maxScrollDistance, virtualScrollPercentage);

      spanBarDOM.style.transform = `translate3d(${left}px, 0, 0)`;
      spanBarDOM.style.transformOrigin = 'left';
    });

    // Update the scroll position of the scroll bar area
    selectRefs(
      this.props.interactiveLayerRef,
      (interactiveLayerRefDOM: HTMLDivElement) => {
        selectRefs(this.scrollBarArea, (scrollBarAreaDOM: HTMLDivElement) => {
          const maxScrollDistance =
            scrollBarAreaDOM.getBoundingClientRect().width - interactiveLayerRect.width;
          const left = lerp(0, maxScrollDistance, virtualScrollPercentage);

          interactiveLayerRefDOM.scrollLeft = left;
        });
      }
    );
  };

  onDragEnd = (event: MouseEvent) => {
    if (!this.isDragging || event.type !== 'mouseup' || !this.hasInteractiveLayer()) {
      return;
    }

    // remove listeners that were attached in onDragStart

    this.cleanUpListeners();

    // restore body styles

    if (this.previousUserSelect) {
      setBodyUserSelect(this.previousUserSelect);
      this.previousUserSelect = null;
    }

    // indicate drag has ended

    this.isDragging = false;

    selectRefs(this.virtualScrollbar, scrollbarDOM => {
      scrollbarDOM.classList.remove('dragging');
      document.body.style.removeProperty('cursor');
    });
  };

  cleanUpListeners = () => {
    if (this.isDragging) {
      // we only remove listeners during a drag
      window.removeEventListener('mousemove', this.onDragMove);
      window.removeEventListener('mouseup', this.onDragEnd);
    }
  };

  markSpanOutOfView = (spanId: string) => {
    if (!this.spansInView.removeSpan(spanId)) {
      return;
    }

    const left = this.spansInView.getScrollVal();
    this.throttledScroll(left, true);
  };

  markSpanInView = (spanId: string, treeDepth: number) => {
    if (!this.spansInView.addSpan(spanId, treeDepth)) {
      return;
    }

    const left = this.spansInView.getScrollVal();
    this.throttledScroll(left, true);
  };

  startAnimation() {
    selectRefs(this.contentSpanBar, (spanBarDOM: HTMLDivElement) => {
      spanBarDOM.style.transition = 'transform 0.3s';
    });

    if (this.animationTimeout) {
      clearTimeout(this.animationTimeout);
    }

    // This timeout is set to trigger immediately after the animation ends, to disable the animation.
    // The animation needs to be cleared, otherwise manual horizontal scrolling will be animated
    this.animationTimeout = setTimeout(() => {
      selectRefs(this.contentSpanBar, (spanBarDOM: HTMLDivElement) => {
        spanBarDOM.style.transition = '';
      });
      this.animationTimeout = null;
    }, 300);
  }

  disableAnimation() {
    selectRefs(this.contentSpanBar, (spanBarDOM: HTMLDivElement) => {
      spanBarDOM.style.transition = '';
    });
  }

  storeSpanBar = (spanBar: SpanBar) => {
    this.spanBars.push(spanBar);
  };

  render() {
    const childrenProps: ScrollbarManagerChildrenProps = {
      generateContentSpanBarRef: this.generateContentSpanBarRef,
      onDragStart: this.onDragStart,
      onScroll: this.onScroll,
      onWheel: this.onWheel,
      virtualScrollbarRef: this.virtualScrollbar,
      scrollBarAreaRef: this.scrollBarArea,
      updateScrollState: this.initializeScrollState,
      markSpanOutOfView: this.markSpanOutOfView,
      markSpanInView: this.markSpanInView,
      storeSpanBar: this.storeSpanBar,
    };

    return (
      <ScrollbarManagerContext.Provider value={childrenProps}>
        {this.props.children}
      </ScrollbarManagerContext.Provider>
    );
  }
}

export const Consumer = ScrollbarManagerContext.Consumer;

export const withScrollbarManager = <P extends ScrollbarManagerChildrenProps>(
  WrappedComponent: React.ComponentType<P>
) =>
  class extends Component<
    Omit<P, keyof ScrollbarManagerChildrenProps> & Partial<ScrollbarManagerChildrenProps>
  > {
    static displayName = `withScrollbarManager(${getDisplayName(WrappedComponent)})`;

    render() {
      return (
        <ScrollbarManagerContext.Consumer>
          {context => {
            const props = {
              ...this.props,
              ...context,
            } as P;

            return <WrappedComponent {...props} />;
          }}
        </ScrollbarManagerContext.Consumer>
      );
    }
  };
