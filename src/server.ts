import {
  RyderCommand,
  RYDER_COMMAND_FIELD,
  RYDER_REQUEST_ID_FIELD,
} from './constants';
import {
  ClientPayload,
  createPayload,
  generateSubscriptionKey,
  isRyderClientPayload,
  noProcessing,
  retry,
} from './utils';

function nonEmpty<T>(item: T | undefined): item is T {
  return item !== undefined;
}

export function createServerBridge(options: {
  serializer?: (value: unknown) => unknown;
  deserializer?: (value: unknown) => unknown;
  retryOnError?:
    | false
    | {
        interval: number;
        limit: number;
      };
  invokeHandler: (propertyPath: PropertyKey[]) => unknown;
  subscriptionHandler: (
    propertyPath: PropertyKey[],
    onValueChange: (value: unknown) => void
  ) => () => void;
}) {
  const {
    serializer = noProcessing,
    deserializer = noProcessing,
    invokeHandler,
    subscriptionHandler,
    retryOnError = false,
  } = options;
  const subscriptionManager = new Map<
    string,
    {
      unsubscribe: () => void;
      listeners: {
        source: MessageEventSource;
        subscriptionRequestId: string;
      }[];
    }
  >();

  async function processPayload(
    source: MessageEventSource,
    payload: ClientPayload,
    requestCoalescing: boolean
  ) {
    switch (payload[RYDER_COMMAND_FIELD]) {
      case RyderCommand.InvokeClient: {
        const {
          propertyPath,
          args,
          [RYDER_REQUEST_ID_FIELD]: requestId,
        } = payload;
        try {
          const act = () => invokeHandler(propertyPath);
          const targetVariable = retryOnError
            ? await retry(act, retryOnError.limit, retryOnError.interval)
            : act;

          const value =
            typeof targetVariable === 'function'
              ? await targetVariable(...args)
              : targetVariable;

          const reponsePayload = createPayload(
            RyderCommand.InvokeServerSuccess,
            {
              value,
            },
            requestId
          );
          console.log(`[InvokeSuccess]: ${requestId}`);
          if (requestCoalescing) {
            return reponsePayload;
          } else {
            source.postMessage(JSON.stringify(serializer(reponsePayload)));
          }
        } catch (ex) {
          const reason = ex instanceof Error ? ex.message : String(ex);
          const responsePayload = createPayload(
            RyderCommand.InvokeServerError,
            { reason },
            requestId
          );
          if (requestCoalescing) {
            return responsePayload;
          } else {
            source.postMessage(JSON.stringify(serializer(responsePayload)));
          }
        }
        break;
      }
      case RyderCommand.SubscribeClient: {
        const { propertyPath } = payload;
        const subscriptionKey = generateSubscriptionKey(propertyPath);
        const sub = subscriptionManager.get(subscriptionKey);
        const clientRequestId = payload[RYDER_REQUEST_ID_FIELD];
        if (sub) {
          sub.listeners.push({
            source,
            subscriptionRequestId: clientRequestId,
          });
        } else {
          const act = () =>
            subscriptionHandler(propertyPath, value => {
              // Send the value changes to all listeners
              const sub = subscriptionManager.get(subscriptionKey);
              if (sub) {
                sub.listeners.forEach(({ source, subscriptionRequestId }) =>
                  source.postMessage(
                    JSON.stringify(
                      serializer(
                        createPayload(
                          RyderCommand.SubscribeServerUpdate,
                          {
                            value,
                          },
                          subscriptionRequestId
                        )
                      )
                    )
                  )
                );
              } else {
                // Potential Memory Leaking
                // need to log the error
              }
            });

          const unsubscribe = retryOnError
            ? await retry(act, retryOnError.limit, retryOnError.interval)
            : act();
          subscriptionManager.set(subscriptionKey, {
            unsubscribe,
            listeners: [{ source, subscriptionRequestId: clientRequestId }],
          });
        }
        const responsePayload = createPayload(
          RyderCommand.SubscribeServerSuccess,
          {},
          clientRequestId
        );
        if (requestCoalescing) {
          return responsePayload;
        } else {
          source.postMessage(JSON.stringify(serializer(responsePayload)));
        }
        break;
      }
      case RyderCommand.UnsubscribeClient: {
        const { propertyPath, subscriptionRequestId } = payload;
        const subscriptionKey = generateSubscriptionKey(propertyPath);
        const sub = subscriptionManager.get(subscriptionKey);

        if (sub) {
          const responsePayload = createPayload(
            RyderCommand.UnsubscribeServerSuccess,
            {},
            payload[RYDER_REQUEST_ID_FIELD]
          );

          if (sub.listeners.length === 1) {
            const unsubscribe = sub.unsubscribe;
            const listener = sub.listeners[0];
            if (listener.subscriptionRequestId === subscriptionRequestId) {
              unsubscribe();
              subscriptionManager.delete(subscriptionKey);
              if (requestCoalescing) {
                return responsePayload;
              } else {
                listener.source.postMessage(
                  JSON.stringify(serializer(responsePayload))
                );
              }
            } else {
              // Unable to get `source`
              // UnsubscribeError
            }
          } else {
            const itemToBeRemoved = sub.listeners.find(
              item => item.subscriptionRequestId === subscriptionRequestId
            );
            if (itemToBeRemoved) {
              sub.listeners = sub.listeners.filter(
                item => item !== itemToBeRemoved
              );
              // UnsubscribeSuccess
              if (requestCoalescing) {
                return responsePayload;
              } else {
                itemToBeRemoved.source.postMessage(
                  JSON.stringify(serializer(responsePayload))
                );
              }
            } else {
              // Unable to get `source`
              //UnsubscribeError
            }
          }
        } else {
          // Unable to get `source`
          // UnsubscribeError
        }
      }
    }
  }

  async function clientPayloadHandler(event: MessageEvent<string>) {
    const { data, source } = event;
    let payload: unknown;
    try {
      payload = deserializer(JSON.parse(data));
    } catch {
      // Unable to parse and deserialize the message. just ignore
      return;
    }

    if (isRyderClientPayload(payload) && source) {
      console.log(`[RyderServer] Payload:`, payload);
      switch (payload[RYDER_COMMAND_FIELD]) {
        case RyderCommand.CoalesceRequestClient: {
          const { requests, [RYDER_REQUEST_ID_FIELD]: requestId } = payload;

          const responses = (
            await Promise.all(
              requests.map(payload => processPayload(source, payload, true))
            )
          ).filter(nonEmpty);

          source.postMessage(
            JSON.stringify(
              serializer(
                createPayload(
                  RyderCommand.CoalesceRequestServer,
                  { responses },
                  requestId
                )
              )
            )
          );
        }
        default:
          await processPayload(source, payload, false);
      }
    } else {
      // Ignore this message
      // It shouldn't come from Ryder
    }
  }

  return {
    sendDiscoveryMessage: (sources: MessageEventSource[]) => {
      sources.forEach(source =>
        source.postMessage(
          JSON.stringify(
            serializer(createPayload(RyderCommand.DiscoveryServer, {}))
          )
        )
      );
    },
    messageHandler: clientPayloadHandler,
  };
}
