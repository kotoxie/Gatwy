// Every RDP tab stays mounted while hidden, and its keyboard/paste/drag handlers live on `window`.
// Wrapping them with this keeps a hidden tab from reacting to input meant for the visible one.
export function whenActive<E>(isActive: () => boolean, handler: (e: E) => void): (e: E) => void {
  return (e) => {
    if (isActive()) handler(e);
  };
}
