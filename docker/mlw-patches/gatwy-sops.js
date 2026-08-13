/**
 * Gatwy: force Moonlight "Optimize game settings" (sops) on every StartStream.
 * Sunshine only applies client/auto resolution when the client launches with sops.
 * Installed early in stream.html so it wraps WebSocket.send before MLW starts.
 */
(function gatwyForceSops() {
  if (typeof WebSocket === 'undefined') return;
  if (WebSocket.prototype.__gatwySopsWrapped) return;
  var originalSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function gatwySopsSend(data) {
    try {
      if (typeof data === 'string' && data.indexOf('StartStream') !== -1) {
        var msg = JSON.parse(data);
        if (msg && msg.StartStream && msg.StartStream.settings) {
          msg.StartStream.settings.sops = true;
          data = JSON.stringify(msg);
        }
      }
    } catch (_err) { /* leave payload unchanged */ }
    return originalSend.call(this, data);
  };
  WebSocket.prototype.__gatwySopsWrapped = true;
})();
