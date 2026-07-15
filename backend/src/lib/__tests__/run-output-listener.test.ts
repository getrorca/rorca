import { publishRunOutputWakeupForTests, subscribeRunOutput } from '../run-output-listener';

describe('run output wake-up fanout', () => {
  test('routes notifications only to subscribers for the matching run', () => {
    const first = jest.fn();
    const second = jest.fn();
    const unsubscribeFirst = subscribeRunOutput(101, first);
    const unsubscribeSecond = subscribeRunOutput(202, second);

    publishRunOutputWakeupForTests(101);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    unsubscribeFirst();
    unsubscribeSecond();
  });

  test('unsubscribe prevents callbacks after an SSE attachment closes', () => {
    const subscriber = jest.fn();
    const unsubscribe = subscribeRunOutput(303, subscriber);
    unsubscribe();

    publishRunOutputWakeupForTests(303);
    expect(subscriber).not.toHaveBeenCalled();
  });
});
