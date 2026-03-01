/**
 * @license
 * Copyright 2013 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 */

addToLibrary({
  $SOCKFS__postset: () => {
    addAtInit('SOCKFS.root = FS.mount(SOCKFS, {}, null);');
  },
  $SOCKFS__deps: ['$FS'],
  $SOCKFS: {
#if expectToReceiveOnModule('websocket')
    websocketArgs: {},
#endif
#if expectToReceiveOnModule('socket')
    socketArgs: {},
#endif
    callbacks: {},
    on(event, callback) {
      SOCKFS.callbacks[event] = callback;
    },
    emit(event, param) {
      SOCKFS.callbacks[event]?.(param);
    },
    mount(mount) {
#if expectToReceiveOnModule('socket')
      // The incoming Module['socket'] can be used to configure transport and
      // transport-specific options.
      SOCKFS.socketArgs = {{{ makeModuleReceiveExpr('socket', '{}') }}};
      // Mirror the event registration API on Module['socket'].
      (Module['socket'] ??= {})['on'] = SOCKFS.on;
#endif
#if expectToReceiveOnModule('websocket')
      // The incoming Module['websocket'] can be used for configuring 
      // subprotocol/url, etc
      SOCKFS.websocketArgs = {{{ makeModuleReceiveExpr('websocket', '{}') }}};
      // Add the Event registration mechanism to the exported websocket configuration
      // object so we can register network callbacks from native JavaScript too.
      // For more documentation see system/include/emscripten/emscripten.h
      (Module['websocket'] ??= {})['on'] = SOCKFS.on;
#endif

#if SOCKET_DEBUG
      // If debug is enabled register simple default logging callbacks for each Event.
      SOCKFS.on('error', (error) => dbg(`websocket: error ${error}`));
      SOCKFS.on('open', (fd) => dbg(`websocket: open fd = ${fd}`));
      SOCKFS.on('listen', (fd) => dbg(`websocket: listen fd = ${fd}`));
      SOCKFS.on('connection', (fd) => dbg(`websocket: connection fd = ${fd}`));
      SOCKFS.on('message', (fd) => dbg(`websocket: message fd = ${fd}`));
      SOCKFS.on('close', (fd) => dbg(`websocket: close fd = ${fd}`));
#endif

      return FS.createNode(null, '/', {{{ cDefs.S_IFDIR | 0o777 }}}, 0);
    },
    getSocketTransport() {
      var transport = '{{{ SOCKET_TRANSPORT }}}';
#if expectToReceiveOnModule('socket')
      if (SOCKFS.socketArgs['transport']) {
        transport = SOCKFS.socketArgs['transport'];
      }
#endif
      transport = String(transport).toLowerCase();
      if (transport != 'webtransport' && transport != 'auto') {
        return 'websocket';
      }
      return transport;
    },
    getWebTransportURL(addr, port) {
      // The replace is needed because the compiler replaces '//' comments with
      // '#', so we'd end up with https:#.
      var url = '{{{ WEBTRANSPORT_URL }}}'.replace('#', '//');
#if expectToReceiveOnModule('socket')
      var webtransportConfig = SOCKFS.socketArgs['webtransport'];
      if (webtransportConfig?.['url']) {
        url = webtransportConfig['url'];
      }
#endif

      if (url === 'https://') {
        var parts = addr.split('/');
        url = url + parts[0] + ':' + port + '/' + parts.slice(1).join('/');
      }
      return url;
    },
    getWebTransportOptions() {
#if expectToReceiveOnModule('socket')
      var webtransportConfig = SOCKFS.socketArgs['webtransport'];
      if (!webtransportConfig || typeof webtransportConfig !== 'object') {
        return undefined;
      }
      var options = {};
      if (webtransportConfig['serverCertificateHashes']) {
        options.serverCertificateHashes = webtransportConfig['serverCertificateHashes'];
      }
      return Object.keys(options).length ? options : undefined;
#else
      return undefined;
#endif
    },
    shouldUseWebTransport(sock) {
      return sock.type === {{{ cDefs.SOCK_DGRAM }}} &&
             (sock.transport === 'webtransport' || sock.transport === 'auto');
    },
    sliceSendData(buffer, offset, length) {
      // Create a detached copy before sending to avoid exposing unrelated bytes
      // from the underlying buffer.
      if (ArrayBuffer.isView(buffer)) {
        offset += buffer.byteOffset;
        buffer = buffer.buffer;
      }
      var data = buffer.slice(offset, offset + length);
#if PTHREADS
      // WebSockets / WebTransport don't accept SharedArrayBuffer payloads.
      if (data instanceof SharedArrayBuffer) {
        data = new Uint8Array(new Uint8Array(data)).buffer;
      }
#endif
      return data;
    },
    createSocket(family, type, protocol) {
      // Emscripten only supports AF_INET
      if (family != {{{ cDefs.AF_INET }}}) {
        throw new FS.ErrnoError({{{ cDefs.EAFNOSUPPORT }}});
      }
      type &= ~{{{ cDefs.SOCK_CLOEXEC | cDefs.SOCK_NONBLOCK }}}; // Some applications may pass it; it makes no sense for a single process.
      // Emscripten only supports SOCK_STREAM and SOCK_DGRAM
      if (type != {{{ cDefs.SOCK_STREAM }}} && type != {{{ cDefs.SOCK_DGRAM }}}) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      var streaming = type == {{{ cDefs.SOCK_STREAM }}};
      if (streaming && protocol && protocol != {{{ cDefs.IPPROTO_TCP }}}) {
        throw new FS.ErrnoError({{{ cDefs.EPROTONOSUPPORT }}}); // if SOCK_STREAM, must be tcp or 0.
      }

      // create our internal socket structure
      var sock = {
        family,
        type,
        protocol,
        server: null,
        error: null, // Used in getsockopt for SOL_SOCKET/SO_ERROR test
        transport: type == {{{ cDefs.SOCK_DGRAM }}} ? SOCKFS.getSocketTransport() : 'websocket',
        peers: {},
        pending: [],
        recv_queue: [],
#if SOCKET_WEBRTC
#else
        sock_ops: SOCKFS.websocket_sock_ops
#endif
      };

      // create the filesystem node to store the socket structure
      var name = SOCKFS.nextname();
      var node = FS.createNode(SOCKFS.root, name, {{{ cDefs.S_IFSOCK }}}, 0);
      node.sock = sock;

      // and the wrapping stream that enables library functions such
      // as read and write to indirectly interact with the socket
      var stream = FS.createStream({
        path: name,
        node,
        flags: {{{ cDefs.O_RDWR }}},
        seekable: false,
        stream_ops: SOCKFS.stream_ops
      });

      // map the new stream to the socket structure (sockets have a 1:1
      // relationship with a stream)
      sock.stream = stream;

      return sock;
    },
    getSocket(fd) {
      var stream = FS.getStream(fd);
      if (!stream || !FS.isSocket(stream.node.mode)) {
        return null;
      }
      return stream.node.sock;
    },
    // node and stream ops are backend agnostic
    stream_ops: {
      poll(stream) {
        var sock = stream.node.sock;
        return sock.sock_ops.poll(sock);
      },
      ioctl(stream, request, varargs) {
        var sock = stream.node.sock;
        return sock.sock_ops.ioctl(sock, request, varargs);
      },
      read(stream, buffer, offset, length, position /* ignored */) {
        var sock = stream.node.sock;
        var msg = sock.sock_ops.recvmsg(sock, length);
        if (!msg) {
          // socket is closed
          return 0;
        }
        buffer.set(msg.buffer, offset);
        return msg.buffer.length;
      },
      write(stream, buffer, offset, length, position /* ignored */) {
        var sock = stream.node.sock;
        return sock.sock_ops.sendmsg(sock, buffer, offset, length);
      },
      close(stream) {
        var sock = stream.node.sock;
        sock.sock_ops.close(sock);
      }
    },
    nextname() {
      if (!SOCKFS.nextname.current) {
        SOCKFS.nextname.current = 0;
      }
      return `socket[${SOCKFS.nextname.current++}]`;
    },
    // backend-specific stream ops
    websocket_sock_ops: {
      //
      // peers are a small wrapper around a WebSocket to help in
      // emulating dgram sockets
      //
      // these functions aren't actually sock_ops members, but we're
      // abusing the namespace to organize them
      //
      createPeer(sock, addr, port) {
        var ws;

        if (typeof addr == 'object') {
          ws = addr;
          addr = null;
          port = null;
        }

        if (ws) {
          // for sockets that've already connected (e.g. we're the server)
          // we can inspect the _socket property for the address
          if (ws._socket) {
            addr = ws._socket.remoteAddress;
            port = ws._socket.remotePort;
          }
          // if we're just now initializing a connection to the remote,
          // inspect the url property
          else {
            var result = /ws[s]?:\/\/([^:]+):(\d+)/.exec(ws.url);
            if (!result) {
              throw new Error('WebSocket URL must be in the format ws(s)://address:port');
            }
            addr = result[1];
            port = parseInt(result[2], 10);
          }
        } else {
          // create the actual websocket object and connect
          try {
            // The default value is 'ws://' the replace is needed because the compiler replaces '//' comments with '#'
            // comments without checking context, so we'd end up with ws:#, the replace swaps the '#' for '//' again.
            var url = '{{{ WEBSOCKET_URL }}}'.replace('#', '//');
            // Make the WebSocket subprotocol (Sec-WebSocket-Protocol) default to binary if no configuration is set.
            var subProtocols = '{{{ WEBSOCKET_SUBPROTOCOL }}}'; // The default value is 'binary'
            // The default WebSocket options
            var opts = undefined;

#if expectToReceiveOnModule('websocket')
            // Fetch runtime WebSocket URL config.
            if (SOCKFS.websocketArgs['url']) {
              url = SOCKFS.websocketArgs['url'];
            }
            // Fetch runtime WebSocket subprotocol config.
            if (SOCKFS.websocketArgs['subprotocol']) {
              subProtocols = SOCKFS.websocketArgs['subprotocol'];
            } else if (SOCKFS.websocketArgs['subprotocol'] === null) {
              subProtocols = 'null'
            }
#endif

            if (url === 'ws://' || url === 'wss://') { // Is the supplied URL config just a prefix, if so complete it.
              var parts = addr.split('/');
              url = url + parts[0] + ":" + port + "/" + parts.slice(1).join('/');
            }

            if (subProtocols !== 'null') {
              // The regex trims the string (removes spaces at the beginning and end), then splits the string by
              // <any space>,<any space> into an Array. Whitespace removal is important for Websockify and ws.
              subProtocols = subProtocols.replace(/^ +| +$/g,"").split(/ *, */);

              opts = subProtocols;
            }

#if SOCKET_DEBUG
            dbg(`websocket: connect: ${url}, ${subProtocols.toString()}`);
#endif
            // If node we use the ws library.
            var WebSocketConstructor;
#if ENVIRONMENT_MAY_BE_NODE
            if (ENVIRONMENT_IS_NODE) {
              WebSocketConstructor = /** @type{(typeof WebSocket)} */(require('ws'));
            } else
#endif // ENVIRONMENT_MAY_BE_NODE
            {
              WebSocketConstructor = WebSocket;
            }
            ws = new WebSocketConstructor(url, opts);
            ws.binaryType = 'arraybuffer';
          } catch (e) {
#if SOCKET_DEBUG
            dbg(`websocket: error connecting: ${e}`);
#endif
            throw new FS.ErrnoError({{{ cDefs.EHOSTUNREACH }}});
          }
        }

#if SOCKET_DEBUG
        dbg(`websocket: adding peer: ${addr}:${port}`);
#endif

        var peer = {
          addr,
          port,
          socket: ws,
          msg_send_queue: []
        };

        SOCKFS.websocket_sock_ops.addPeer(sock, peer);
        SOCKFS.websocket_sock_ops.handlePeerEvents(sock, peer);

        // if this is a bound dgram socket, send the port number first to allow
        // us to override the ephemeral port reported to us by remotePort on the
        // remote end.
        if (sock.type === {{{ cDefs.SOCK_DGRAM }}} && typeof sock.sport != 'undefined') {
#if SOCKET_DEBUG
          dbg(`websocket: queuing port message (port ${sock.sport})`);
#endif
          peer.msg_send_queue.push(new Uint8Array([
              255, 255, 255, 255,
              'p'.charCodeAt(0), 'o'.charCodeAt(0), 'r'.charCodeAt(0), 't'.charCodeAt(0),
              ((sock.sport & 0xff00) >> 8) , (sock.sport & 0xff)
          ]));
        }

        return peer;
      },
      getPeer(sock, addr, port) {
        return sock.peers[addr + ':' + port];
      },
      addPeer(sock, peer) {
        sock.peers[peer.addr + ':' + peer.port] = peer;
      },
      removePeer(sock, peer) {
        delete sock.peers[peer.addr + ':' + peer.port];
      },
      handlePeerEvents(sock, peer) {
        var first = true;

        var handleOpen = function () {
#if SOCKET_DEBUG
          dbg('websocket: handle open');
#endif

          sock.connecting = false;
          SOCKFS.emit('open', sock.stream.fd);

          try {
            var queued = peer.msg_send_queue.shift();
            while (queued) {
#if SOCKET_DEBUG
              dbg(`websocket: sending queued data (${queued.byteLength} bytes): ${new Uint8Array(queued)}`);
#endif
              peer.socket.send(queued);
              queued = peer.msg_send_queue.shift();
            }
          } catch (e) {
            // not much we can do here in the way of proper error handling as we've already
            // lied and said this data was sent. shut it down.
            peer.socket.close();
          }
        };

        function handleMessage(data) {
          if (typeof data == 'string') {
            var encoder = new TextEncoder(); // should be utf-8
            data = encoder.encode(data); // make a typed array from the string
          } else {
#if ASSERTIONS
            assert(data.byteLength !== undefined); // must receive an ArrayBuffer
#endif
            if (data.byteLength == 0) {
              // An empty ArrayBuffer will emit a pseudo disconnect event
              // as recv/recvmsg will return zero which indicates that a socket
              // has performed a shutdown although the connection has not been disconnected yet.
              return;
            }
            data = new Uint8Array(data); // make a typed array view on the array buffer
          }

#if SOCKET_DEBUG
          dbg(`websocket: handle message (${data.byteLength} bytes): ${data}`);
#endif

          // if this is the port message, override the peer's port with it
          var wasfirst = first;
          first = false;
          if (wasfirst &&
              data.length === 10 &&
              data[0] === 255 && data[1] === 255 && data[2] === 255 && data[3] === 255 &&
              data[4] === 'p'.charCodeAt(0) && data[5] === 'o'.charCodeAt(0) && data[6] === 'r'.charCodeAt(0) && data[7] === 't'.charCodeAt(0)) {
            // update the peer's port and its key in the peer map
            var newport = ((data[8] << 8) | data[9]);
            SOCKFS.websocket_sock_ops.removePeer(sock, peer);
            peer.port = newport;
            SOCKFS.websocket_sock_ops.addPeer(sock, peer);
            return;
          }

          sock.recv_queue.push({ addr: peer.addr, port: peer.port, data: data });
          SOCKFS.emit('message', sock.stream.fd);
        };

        if (ENVIRONMENT_IS_NODE) {
          peer.socket.on('open', handleOpen);
          peer.socket.on('message', function(data, isBinary) {
            if (!isBinary) {
              return;
            }
            handleMessage((new Uint8Array(data)).buffer); // copy from node Buffer -> ArrayBuffer
          });
          peer.socket.on('close', function() {
            SOCKFS.emit('close', sock.stream.fd);
          });
          peer.socket.on('error', function(error) {
            // Although the ws library may pass errors that may be more descriptive than
            // ECONNREFUSED they are not necessarily the expected error code e.g.
            // ENOTFOUND on getaddrinfo seems to be node.js specific, so using ECONNREFUSED
            // is still probably the most useful thing to do.
            sock.error = {{{ cDefs.ECONNREFUSED }}}; // Used in getsockopt for SOL_SOCKET/SO_ERROR test.
            SOCKFS.emit('error', [sock.stream.fd, sock.error, 'ECONNREFUSED: Connection refused']);
            // don't throw
          });
        } else {
          peer.socket.onopen = handleOpen;
          peer.socket.onclose = function() {
            SOCKFS.emit('close', sock.stream.fd);
          };
          peer.socket.onmessage = function peer_socket_onmessage(event) {
            handleMessage(event.data);
          };
          peer.socket.onerror = function(error) {
            // The WebSocket spec only allows a 'simple event' to be thrown on error,
            // so we only really know as much as ECONNREFUSED.
            sock.error = {{{ cDefs.ECONNREFUSED }}}; // Used in getsockopt for SOL_SOCKET/SO_ERROR test.
            SOCKFS.emit('error', [sock.stream.fd, sock.error, 'ECONNREFUSED: Connection refused']);
          };
        }
      },

      //
      // actual sock ops
      //
      poll(sock) {
        if (sock.type === {{{ cDefs.SOCK_STREAM }}} && sock.server) {
          // listen sockets should only say they're available for reading
          // if there are pending clients.
          return sock.pending.length ? ({{{ cDefs.POLLRDNORM }}} | {{{ cDefs.POLLIN }}}) : 0;
        }

        var mask = 0;
        var dest = sock.type === {{{ cDefs.SOCK_STREAM }}} ?  // we only care about the socket state for connection-based sockets
          SOCKFS.websocket_sock_ops.getPeer(sock, sock.daddr, sock.dport) :
          null;

        if (sock.recv_queue.length ||
            !dest ||  // connection-less sockets are always ready to read
            (dest && dest.socket.readyState === dest.socket.CLOSING) ||
            (dest && dest.socket.readyState === dest.socket.CLOSED)) {  // let recv return 0 once closed
          mask |= ({{{ cDefs.POLLRDNORM }}} | {{{ cDefs.POLLIN }}});
        }

        if (!dest ||  // connection-less sockets are always ready to write
            (dest && dest.socket.readyState === dest.socket.OPEN)) {
          mask |= {{{ cDefs.POLLOUT }}};
        }

        if ((dest && dest.socket.readyState === dest.socket.CLOSING) ||
            (dest && dest.socket.readyState === dest.socket.CLOSED)) {
          // When an non-blocking connect fails mark the socket as writable.
          // Its up to the calling code to then use getsockopt with SO_ERROR to
          // retrieve the error.
          // See https://man7.org/linux/man-pages/man2/connect.2.html
          if (sock.connecting) {
            mask |= {{{ cDefs.POLLOUT }}};
          } else  {
            mask |= {{{ cDefs.POLLHUP }}};
          }
        }

        return mask;
      },
      ioctl(sock, request, arg) {
        switch (request) {
          case {{{ cDefs.FIONREAD }}}:
            var bytes = 0;
            if (sock.recv_queue.length) {
              bytes = sock.recv_queue[0].data.length;
            }
            {{{ makeSetValue('arg', '0', 'bytes', 'i32') }}};
            return 0;
          case {{{ cDefs.FIONBIO }}}:
            var on = {{{ makeGetValue('arg', '0', 'i32') }}};
            if (on) {
              sock.stream.flags |= {{{ cDefs.O_NONBLOCK }}};
            } else {
              sock.stream.flags &= ~{{{ cDefs.O_NONBLOCK }}};
            }
            return 0;
          default:
            return {{{ cDefs.EINVAL }}};
        }
      },
      close(sock) {
        if (sock.h3) {
          try {
            SOCKFS.webtransport_sock_ops.stopListenServer(sock);
          } catch (e) {
          }
        }
        // if we've spawned a listen server, close it
        if (sock.server) {
          try {
            sock.server.close();
          } catch (e) {
          }
          sock.server = null;
        }
        // close any peer connections
        for (var peer of Object.values(sock.peers)) {
          try {
            if (peer.socket) {
              peer.socket.close();
            } else if (peer.transport) {
              peer.reader?.cancel();
              peer.writer?.releaseLock();
              peer.transport.close();
            }
          } catch (e) {
          }
          SOCKFS.websocket_sock_ops.removePeer(sock, peer);
        }
        return 0;
      },
      bind(sock, addr, port) {
        if (typeof sock.saddr != 'undefined' || typeof sock.sport != 'undefined') {
          throw new FS.ErrnoError({{{ cDefs.EINVAL }}});  // already bound
        }
        sock.saddr = addr;
        sock.sport = port;
        // in order to emulate dgram sockets, we need to launch a listen server when
        // binding on a connection-less socket
        // note: this is only required on the server side
        if (sock.type === {{{ cDefs.SOCK_DGRAM }}}) {
          if (SOCKFS.shouldUseWebTransport(sock)) {
            // For UDP + WebTransport use a native WebTransport listener in Node.
            try {
              SOCKFS.webtransport_sock_ops.listen(sock, 0);
            } catch (e) {
              if (!(e.name === 'ErrnoError')) throw e;
              if (e.errno !== {{{ cDefs.EOPNOTSUPP }}}) throw e;
            }
            return;
          }
          // close the existing server if it exists
          if (sock.server) {
            sock.server.close();
            sock.server = null;
          }
          // swallow error operation not supported error that occurs when binding in the
          // browser where this isn't supported
          try {
            sock.sock_ops.listen(sock, 0);
          } catch (e) {
            if (!(e.name === 'ErrnoError')) throw e;
            if (e.errno !== {{{ cDefs.EOPNOTSUPP }}}) throw e;
          }
        }
      },
      connect(sock, addr, port) {
        if (sock.server) {
          throw new FS.ErrnoError({{{ cDefs.EOPNOTSUPP }}});
        }

        if (SOCKFS.shouldUseWebTransport(sock)) {
          SOCKFS.webtransport_sock_ops.connect(sock, addr, port);
          return;
        }

        // TODO autobind
        // if (!sock.addr && sock.type == {{{ cDefs.SOCK_DGRAM }}}) {
        // }

        // early out if we're already connected / in the middle of connecting
        if (typeof sock.daddr != 'undefined' && typeof sock.dport != 'undefined') {
          var dest = SOCKFS.websocket_sock_ops.getPeer(sock, sock.daddr, sock.dport);
          if (dest) {
            if (dest.socket.readyState === dest.socket.CONNECTING) {
              throw new FS.ErrnoError({{{ cDefs.EALREADY }}});
            } else {
              throw new FS.ErrnoError({{{ cDefs.EISCONN }}});
            }
          }
        }

        // add the socket to our peer list and set our
        // destination address / port to match
        var peer = SOCKFS.websocket_sock_ops.createPeer(sock, addr, port);
        sock.daddr = peer.addr;
        sock.dport = peer.port;

        // because we cannot synchronously block to wait for the WebSocket
        // connection to complete, we return here pretending that the connection
        // was a success.
        sock.connecting = true;
      },
      listen(sock, backlog) {
        if (!ENVIRONMENT_IS_NODE) {
          throw new FS.ErrnoError({{{ cDefs.EOPNOTSUPP }}});
        }
#if ENVIRONMENT_MAY_BE_NODE
        if (sock.server) {
           throw new FS.ErrnoError({{{ cDefs.EINVAL }}});  // already listening
        }
        var WebSocketServer = require('ws').Server;
        var host = sock.saddr;
#if SOCKET_DEBUG
        dbg(`websocket: listen: ${host}:${sock.sport}`);
#endif
        sock.server = new WebSocketServer({
          host,
          port: sock.sport
          // TODO support backlog
        });
        SOCKFS.emit('listen', sock.stream.fd); // Send Event with listen fd.

        sock.server.on('connection', function(ws) {
#if SOCKET_DEBUG
          dbg(`websocket: received connection from: ${ws._socket.remoteAddress}:${ws._socket.remotePort}`);
#endif
          if (sock.type === {{{ cDefs.SOCK_STREAM }}}) {
            var newsock = SOCKFS.createSocket(sock.family, sock.type, sock.protocol);

            // create a peer on the new socket
            var peer = SOCKFS.websocket_sock_ops.createPeer(newsock, ws);
            newsock.daddr = peer.addr;
            newsock.dport = peer.port;

            // push to queue for accept to pick up
            sock.pending.push(newsock);
            SOCKFS.emit('connection', newsock.stream.fd);
          } else {
            // create a peer on the listen socket so calling sendto
            // with the listen socket and an address will resolve
            // to the correct client
            SOCKFS.websocket_sock_ops.createPeer(sock, ws);
            SOCKFS.emit('connection', sock.stream.fd);
          }
        });
        sock.server.on('close', function() {
          SOCKFS.emit('close', sock.stream.fd);
          sock.server = null;
        });
        sock.server.on('error', function(error) {
          // Although the ws library may pass errors that may be more descriptive than
          // ECONNREFUSED they are not necessarily the expected error code e.g.
          // ENOTFOUND on getaddrinfo seems to be node.js specific, so using EHOSTUNREACH
          // is still probably the most useful thing to do. This error shouldn't
          // occur in a well written app as errors should get trapped in the compiled
          // app's own getaddrinfo call.
          sock.error = {{{ cDefs.EHOSTUNREACH }}}; // Used in getsockopt for SOL_SOCKET/SO_ERROR test.
          SOCKFS.emit('error', [sock.stream.fd, sock.error, 'EHOSTUNREACH: Host is unreachable']);
          // don't throw
        });
#endif // ENVIRONMENT_MAY_BE_NODE
      },
      accept(listensock) {
        if (!listensock.server || !listensock.pending.length) {
          throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
        }
        var newsock = listensock.pending.shift();
        newsock.stream.flags = listensock.stream.flags;
        return newsock;
      },
      getname(sock, peer) {
        var addr, port;
        if (peer) {
          if (sock.daddr === undefined || sock.dport === undefined) {
            throw new FS.ErrnoError({{{ cDefs.ENOTCONN }}});
          }
          addr = sock.daddr;
          port = sock.dport;
        } else {
          // TODO saddr and sport will be set for bind()'d UDP sockets, but what
          // should we be returning for TCP sockets that've been connect()'d?
          addr = sock.saddr || 0;
          port = sock.sport || 0;
        }
        return { addr, port };
      },
      sendmsg(sock, buffer, offset, length, addr, port, skipTransportRouting) {
        if (sock.type === {{{ cDefs.SOCK_DGRAM }}}) {
          // connection-less sockets will honor the message address,
          // and otherwise fall back to the bound destination address
          if (addr === undefined || port === undefined) {
            addr = sock.daddr;
            port = sock.dport;
          }
          // if there was no address to fall back to, error out
          if (addr === undefined || port === undefined) {
            throw new FS.ErrnoError({{{ cDefs.EDESTADDRREQ }}});
          }
        } else {
          // connection-based sockets will only use the bound
          addr = sock.daddr;
          port = sock.dport;
        }

        if (!skipTransportRouting && SOCKFS.shouldUseWebTransport(sock)) {
          return SOCKFS.webtransport_sock_ops.sendmsg(sock, buffer, offset, length, addr, port);
        }

        // find the peer for the destination address
        var dest = SOCKFS.websocket_sock_ops.getPeer(sock, addr, port);

        // early out if not connected with a connection-based socket
        if (sock.type === {{{ cDefs.SOCK_STREAM }}}) {
          if (!dest || dest.socket.readyState === dest.socket.CLOSING || dest.socket.readyState === dest.socket.CLOSED) {
            throw new FS.ErrnoError({{{ cDefs.ENOTCONN }}});
#if SOCKET_DEBUG
          } else if (dest.socket.readyState === dest.socket.CONNECTING) {
            dbg('socket sendmsg called while socket is still connecting.');
#endif
          }
        }

        var data = SOCKFS.sliceSendData(buffer, offset, length);

        // if we don't have a cached connectionless UDP datagram connection, or
        // the TCP socket is still connecting, queue the message to be sent upon
        // connect, and lie, saying the data was sent now.
        if (!dest || dest.socket.readyState !== dest.socket.OPEN) {
          // if we're not connected, open a new connection
          if (sock.type === {{{ cDefs.SOCK_DGRAM }}}) {
            if (!dest || dest.socket.readyState === dest.socket.CLOSING || dest.socket.readyState === dest.socket.CLOSED) {
              dest = SOCKFS.websocket_sock_ops.createPeer(sock, addr, port);
            }
          }
#if SOCKET_DEBUG
          dbg(`websocket: queuing (${length} bytes): ${new Uint8Array(data)}`);
#endif
          dest.msg_send_queue.push(data);
          return length;
        }

        try {
#if SOCKET_DEBUG
          dbg(`websocket: send (${length} bytes): ${new Uint8Array(data)}`);
#endif
          // send the actual data
          dest.socket.send(data);
          return length;
        } catch (e) {
          throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
        }
      },
      recvmsg(sock, length) {
        // http://pubs.opengroup.org/onlinepubs/7908799/xns/recvmsg.html
        if (sock.type === {{{ cDefs.SOCK_STREAM }}} && sock.server) {
          // tcp servers should not be recv()'ing on the listen socket
          throw new FS.ErrnoError({{{ cDefs.ENOTCONN }}});
        }

        var queued = sock.recv_queue.shift();
        if (!queued) {
          if (sock.type === {{{ cDefs.SOCK_STREAM }}}) {
            var dest = SOCKFS.websocket_sock_ops.getPeer(sock, sock.daddr, sock.dport);

            if (!dest) {
              // if we have a destination address but are not connected, error out
              throw new FS.ErrnoError({{{ cDefs.ENOTCONN }}});
            }
            if (dest.socket.readyState === dest.socket.CLOSING || dest.socket.readyState === dest.socket.CLOSED) {
              // return null if the socket has closed
              return null;
            }
            // else, our socket is in a valid state but truly has nothing available
            throw new FS.ErrnoError({{{ cDefs.EAGAIN }}});
          }
          throw new FS.ErrnoError({{{ cDefs.EAGAIN }}});
        }

        // queued.data will be an ArrayBuffer if it's unadulterated, but if it's
        // requeued TCP data it'll be an ArrayBufferView
        var queuedLength = queued.data.byteLength || queued.data.length;
        var queuedOffset = queued.data.byteOffset || 0;
        var queuedBuffer = queued.data.buffer || queued.data;
        var bytesRead = Math.min(length, queuedLength);
        var res = {
          buffer: new Uint8Array(queuedBuffer, queuedOffset, bytesRead),
          addr: queued.addr,
          port: queued.port
        };

#if SOCKET_DEBUG
        dbg(`websocket: read (${bytesRead} bytes): ${res.buffer}`);
#endif

        // push back any unread data for TCP connections
        if (sock.type === {{{ cDefs.SOCK_STREAM }}} && bytesRead < queuedLength) {
          var bytesRemaining = queuedLength - bytesRead;
#if SOCKET_DEBUG
          dbg(`websocket: read: put back ${bytesRemaining} bytes`);
#endif
          queued.data = new Uint8Array(queuedBuffer, queuedOffset + bytesRead, bytesRemaining);
          sock.recv_queue.unshift(queued);
        }

        return res;
      }
    },
    webtransport_sock_ops: {
      normalizePeerAddr(addr) {
        if (addr === null || typeof addr === 'undefined') {
          return '0.0.0.0';
        }
        addr = String(addr);
        if (addr.startsWith('::ffff:')) {
          return addr.slice(7);
        }
        if (addr === '::1') {
          return '127.0.0.1';
        }
        return addr;
      },
      peerKey(addr, port) {
        return SOCKFS.webtransport_sock_ops.normalizePeerAddr(addr) + ':' + (port | 0);
      },
      getServerOptions() {
        var options = globalThis.__Q3JS_WEBTRANSPORT_SERVER_OPTIONS || {};
        var moduleOptions = (typeof Module !== 'undefined' && Module) ? Module : {};
        var cert = options.cert || moduleOptions['cert'];
        var privKey = options.privKey || moduleOptions['key'] || moduleOptions['privKey'];
        var secret = options.secret || moduleOptions['secret'] || 'q3js-webtransport-secret';
        var path = options.path || moduleOptions['path'] || '/';
        return {
          cert,
          privKey,
          secret,
          path,
          fatalListenError: options.fatalListenError !== false
        };
      },
      terminateOnListenFailure(sock, message, options) {
        if (!ENVIRONMENT_IS_NODE || !options.fatalListenError) {
          return;
        }
#if ENVIRONMENT_MAY_BE_NODE
        try {
          SOCKFS.webtransport_sock_ops.stopListenServer(sock);
        } catch (e) {
        }
        err(message);
        if (typeof process != 'undefined' && typeof process.exit == 'function') {
          process.exit(1);
        }
#endif
      },
      startListenServer(sock) {
        if (!ENVIRONMENT_IS_NODE) {
          throw new FS.ErrnoError({{{ cDefs.EOPNOTSUPP }}});
        }
        if (sock.h3) {
          return;
        }

        var Http3ServerConstructor = globalThis.Http3Server;
        if (!Http3ServerConstructor) {
          SOCKFS.webtransport_sock_ops.emitError(sock, 'ECONNREFUSED: Http3Server unavailable');
          throw new FS.ErrnoError({{{ cDefs.EPROTONOSUPPORT }}});
        }

        var options = SOCKFS.webtransport_sock_ops.getServerOptions();
        if (!options.cert || !options.privKey) {
          SOCKFS.webtransport_sock_ops.emitError(sock, 'ECONNREFUSED: WebTransport server requires certificate and key');
          throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
        }

        var host = sock.saddr || '0.0.0.0';
        var port = sock.sport || 0;
#if SOCKET_DEBUG
        dbg(`webtransport: listen: ${host}:${port}`);
#endif
        sock.h3 = new Http3ServerConstructor({
          host,
          port,
          secret: options.secret,
          cert: options.cert,
          privKey: options.privKey
        });

        sock.h3.ready.then(() => {
          out(`WebTransport listener ready on https://${host}:${port}${options.path}`);
          SOCKFS.emit('listen', sock.stream.fd);
        }).catch((e) => {
          var message = `ECONNREFUSED: WebTransport listen failed (${e})`;
          SOCKFS.webtransport_sock_ops.emitError(sock, message);
          SOCKFS.webtransport_sock_ops.terminateOnListenFailure(sock, message, options);
        });

        try {
          sock.h3.startServer();
          sock.h3SessionReader = sock.h3.sessionStream(options.path).getReader();
        } catch (e) {
          var message = `ECONNREFUSED: WebTransport listen setup failed (${e})`;
          SOCKFS.webtransport_sock_ops.emitError(sock, message);
          SOCKFS.webtransport_sock_ops.terminateOnListenFailure(sock, message, options);
          throw new FS.ErrnoError({{{ cDefs.ECONNREFUSED }}});
        }
        SOCKFS.webtransport_sock_ops.readIncomingSessions(sock, sock.h3SessionReader);
      },
      stopListenServer(sock) {
        try {
          sock.h3SessionReader?.cancel();
        } catch (e) {
        }
        sock.h3SessionReader = null;
        try {
          sock.h3?.stopServer();
        } catch (e) {
        }
        sock.h3 = null;
      },
      readIncomingSessions(sock, sessionReader) {
        sessionReader.read().then((result) => {
          if (result.done) {
            return;
          }
          SOCKFS.webtransport_sock_ops.acceptSession(sock, result.value);
          SOCKFS.webtransport_sock_ops.readIncomingSessions(sock, sessionReader);
        }).catch((e) => {
          SOCKFS.webtransport_sock_ops.emitError(sock, `ECONNREFUSED: WebTransport accept failed (${e})`);
        });
      },
      acceptSession(sock, session) {
        var remote = session?.cobj?.intSession?.jsobj || {};
        var addr = SOCKFS.webtransport_sock_ops.normalizePeerAddr(
          remote.remoteAddress || remote.address || '0.0.0.0'
        );
        var port = (remote.remotePort || remote.port || 0) | 0;
        // Some implementations do not expose remotePort; synthesize a stable
        // port per accepted session to keep sockaddr mapping deterministic.
        if (!port) {
          if (!sock.nextPeerPort || sock.nextPeerPort > 65000) {
            sock.nextPeerPort = 40000;
          }
          port = sock.nextPeerPort++;
        }
        var peer = {
          addr,
          port,
          transport: session,
          msg_send_queue: [],
          ready: false,
          closed: false,
          writer: null,
          reader: null
        };
        SOCKFS.webtransport_sock_ops.addPeer(sock, peer);
        SOCKFS.webtransport_sock_ops.handlePeerEvents(sock, peer);
        SOCKFS.emit('connection', sock.stream.fd);
      },
      getPeer(sock, addr, port) {
        var key = SOCKFS.webtransport_sock_ops.peerKey(addr, port);
        var peer = sock.peers[key];
        if (peer) {
          return peer;
        }
        addr = String(addr || '');
        if (addr.startsWith('::ffff:')) {
          return sock.peers[(addr.slice(7)) + ':' + (port | 0)];
        }
        if (addr && addr.indexOf(':') === -1) {
          return sock.peers['::ffff:' + addr + ':' + (port | 0)];
        }
        return null;
      },
      addPeer(sock, peer) {
        peer.addr = SOCKFS.webtransport_sock_ops.normalizePeerAddr(peer.addr);
        peer.port = (peer.port | 0);
        var keys = [];
        var addKey = (key) => {
          if (!sock.peers[key]) {
            sock.peers[key] = peer;
          }
          if (!keys.includes(key)) {
            keys.push(key);
          }
        };
        addKey(SOCKFS.webtransport_sock_ops.peerKey(peer.addr, peer.port));
        if (peer.addr.indexOf(':') === -1) {
          addKey('::ffff:' + peer.addr + ':' + peer.port);
        } else if (peer.addr.startsWith('::ffff:')) {
          addKey(peer.addr.slice(7) + ':' + peer.port);
        }
        if (peer.addr === '127.0.0.1') {
          addKey('::1:' + peer.port);
        } else if (peer.addr === '::1') {
          addKey('127.0.0.1:' + peer.port);
        }
        peer._peerKeys = keys;
      },
      removePeer(sock, peer) {
        if (peer?._peerKeys?.length) {
          for (var key of peer._peerKeys) {
            if (sock.peers[key] === peer) {
              delete sock.peers[key];
            }
          }
          peer._peerKeys = [];
          return;
        }
        delete sock.peers[SOCKFS.webtransport_sock_ops.peerKey(peer.addr, peer.port)];
      },
      emitError(sock, message) {
        sock.error = {{{ cDefs.ECONNREFUSED }}};
        if (ENVIRONMENT_IS_NODE) {
          err(message);
        }
        SOCKFS.emit('error', [sock.stream.fd, sock.error, message]);
      },
      closePeer(sock, peer) {
        if (peer.closed) {
          return;
        }
        peer.closed = true;
        SOCKFS.webtransport_sock_ops.removePeer(sock, peer);
        try {
          peer.reader?.cancel();
        } catch (e) {
        }
        try {
          peer.writer?.releaseLock();
        } catch (e) {
        }
        try {
          peer.transport?.close();
        } catch (e) {
        }
      },
      fallbackToWebSocket(sock, addr, port, reason) {
#if SOCKET_DEBUG
        dbg(`webtransport: fallback to websocket (${reason})`);
#endif
        // In strict WebTransport mode, do not silently downgrade to WebSocket.
        if (sock.transport !== 'auto') {
          SOCKFS.webtransport_sock_ops.emitError(sock, `ECONNREFUSED: WebTransport required (${reason})`);
          throw new FS.ErrnoError({{{ cDefs.EPROTONOSUPPORT }}});
        }
        sock.error = {{{ cDefs.EPROTONOSUPPORT }}};
        sock.transport = 'websocket';
        return SOCKFS.websocket_sock_ops.createPeer(sock, addr, port);
      },
      fallbackPeerToWebSocket(sock, peer, reason) {
        var queued = peer.msg_send_queue.slice();
        var addr = peer.addr;
        var port = peer.port;
        SOCKFS.webtransport_sock_ops.closePeer(sock, peer);
        var fallbackPeer = SOCKFS.webtransport_sock_ops.fallbackToWebSocket(sock, addr, port, reason);
        for (var data of queued) {
          fallbackPeer.msg_send_queue.push(data);
        }
        return fallbackPeer;
      },
      createPeer(sock, addr, port) {
        var WebTransportConstructor = globalThis.WebTransport;
        if (!WebTransportConstructor) {
          return SOCKFS.webtransport_sock_ops.fallbackToWebSocket(sock, addr, port, 'WebTransport API unavailable');
        }

        var session;
        var url = SOCKFS.getWebTransportURL(addr, port);
        var options = SOCKFS.getWebTransportOptions();
#if SOCKET_DEBUG
        dbg(`webtransport: connect: ${url}`);
#endif
        try {
          session = options ? new WebTransportConstructor(url, options) : new WebTransportConstructor(url);
        } catch (e) {
          return SOCKFS.webtransport_sock_ops.fallbackToWebSocket(sock, addr, port, `WebTransport constructor failed: ${e}`);
        }

        var peer = {
          addr,
          port,
          transport: session,
          msg_send_queue: [],
          ready: false,
          closed: false,
          writer: null,
          reader: null
        };
        SOCKFS.webtransport_sock_ops.addPeer(sock, peer);
        SOCKFS.webtransport_sock_ops.handlePeerEvents(sock, peer);
        return peer;
      },
      connect(sock, addr, port) {
        if (sock.transport === 'websocket') {
          SOCKFS.websocket_sock_ops.connect(sock, addr, port);
          return;
        }

        if (typeof sock.daddr != 'undefined' && typeof sock.dport != 'undefined') {
          var dest = SOCKFS.webtransport_sock_ops.getPeer(sock, sock.daddr, sock.dport);
          if (dest) {
            if (!dest.ready && !dest.closed) {
              throw new FS.ErrnoError({{{ cDefs.EALREADY }}});
            }
            throw new FS.ErrnoError({{{ cDefs.EISCONN }}});
          }
        }

        var peer = SOCKFS.webtransport_sock_ops.createPeer(sock, addr, port);
        sock.daddr = peer.addr;
        sock.dport = peer.port;
        sock.connecting = true;
      },
      listen(sock, backlog) {
        SOCKFS.webtransport_sock_ops.startListenServer(sock);
      },
      flushSendQueue(sock, peer) {
        var queued = peer.msg_send_queue.shift();
        while (queued) {
#if SOCKET_DEBUG
          dbg(`webtransport: sending queued data (${queued.byteLength} bytes): ${new Uint8Array(queued)}`);
#endif
          peer.writer.write(new Uint8Array(queued)).catch((e) => {
            SOCKFS.webtransport_sock_ops.emitError(sock, `ECONNREFUSED: WebTransport send failed (${e})`);
          });
          queued = peer.msg_send_queue.shift();
        }
      },
      readIncomingDatagrams(sock, peer) {
        (async () => {
          while (!peer.closed) {
            var result = await peer.reader.read();
            if (result.done || peer.closed) {
              break;
            }
            var value = result.value;
            if (!value || !value.byteLength) {
              continue;
            }
            var data = value instanceof Uint8Array ? value : new Uint8Array(value);
            sock.recv_queue.push({ addr: peer.addr, port: peer.port, data });
            SOCKFS.emit('message', sock.stream.fd);
          }
        })().catch((e) => {
          if (!peer.closed) {
            SOCKFS.webtransport_sock_ops.emitError(sock, `ECONNREFUSED: WebTransport receive failed (${e})`);
          }
        });
      },
      handlePeerEvents(sock, peer) {
        peer.transport.ready.then(() => {
          if (peer.closed) {
            return;
          }
          try {
            var datagrams = peer.transport.datagrams;
            if (datagrams?.createWritable) {
              peer.writer = datagrams.createWritable().getWriter();
            } else {
              peer.writer = datagrams.writable.getWriter();
            }
            peer.reader = datagrams.readable.getReader();
          } catch (e) {
            try {
              SOCKFS.webtransport_sock_ops.fallbackPeerToWebSocket(sock, peer, `Datagram setup failed: ${e}`);
            } catch (fallbackError) {
              var msg = fallbackError?.message || String(fallbackError);
              SOCKFS.webtransport_sock_ops.emitError(sock, `ECONNREFUSED: WebTransport fallback failed (${msg})`);
            }
            return;
          }
          peer.ready = true;
          sock.connecting = false;
          SOCKFS.emit('open', sock.stream.fd);
          SOCKFS.webtransport_sock_ops.flushSendQueue(sock, peer);
          SOCKFS.webtransport_sock_ops.readIncomingDatagrams(sock, peer);
        }).catch((e) => {
          try {
            SOCKFS.webtransport_sock_ops.fallbackPeerToWebSocket(sock, peer, `Session ready failed: ${e}`);
          } catch (fallbackError) {
            var msg = fallbackError?.message || String(fallbackError);
            SOCKFS.webtransport_sock_ops.emitError(sock, `ECONNREFUSED: WebTransport fallback failed (${msg})`);
          }
        });

        peer.transport.closed.then(() => {
          if (peer.closed) {
            return;
          }
          SOCKFS.webtransport_sock_ops.closePeer(sock, peer);
          SOCKFS.emit('close', sock.stream.fd);
        }).catch((e) => {
          if (peer.closed) {
            return;
          }
          SOCKFS.webtransport_sock_ops.emitError(sock, `ECONNREFUSED: WebTransport closed with error (${e})`);
          SOCKFS.webtransport_sock_ops.closePeer(sock, peer);
          SOCKFS.emit('close', sock.stream.fd);
        });
      },
      sendmsg(sock, buffer, offset, length, addr, port) {
        if (sock.transport === 'websocket') {
          return SOCKFS.websocket_sock_ops.sendmsg(sock, buffer, offset, length, addr, port);
        }

        var dest = SOCKFS.webtransport_sock_ops.getPeer(sock, addr, port);
        if (!dest || dest.closed) {
          if (sock.h3) {
            SOCKFS.webtransport_sock_ops.emitError(
              sock,
              `EHOSTUNREACH: no WebTransport peer for ${SOCKFS.webtransport_sock_ops.normalizePeerAddr(addr)}:${port | 0}`
            );
            throw new FS.ErrnoError({{{ cDefs.EHOSTUNREACH }}});
          }
          dest = SOCKFS.webtransport_sock_ops.createPeer(sock, addr, port);
        }

        if (dest.socket) {
          // Route through websocket send without transport re-dispatching to avoid
          // recursion for peers created by websocket listen paths.
          return SOCKFS.websocket_sock_ops.sendmsg(sock, buffer, offset, length, addr, port, true);
        }

        var data = SOCKFS.sliceSendData(buffer, offset, length);
        if (!dest.ready || !dest.writer) {
#if SOCKET_DEBUG
          dbg(`webtransport: queuing (${length} bytes): ${new Uint8Array(data)}`);
#endif
          dest.msg_send_queue.push(data);
          return length;
        }

#if SOCKET_DEBUG
        dbg(`webtransport: send (${length} bytes): ${new Uint8Array(data)}`);
#endif
        dest.writer.write(new Uint8Array(data)).catch((e) => {
          SOCKFS.webtransport_sock_ops.emitError(sock, `ECONNREFUSED: WebTransport send failed (${e})`);
        });
        return length;
      }
    }
  },

  /*
   * Mechanism to register handlers for the various Socket Events from C code.
   * The registration functions are mostly variations on a theme, so we use this
   * generic handler. Most of the callback functions take a file descriptor as a
   * parameter, which will get passed to them by the emitting call. The error
   * callback also takes an int representing the errno and a char* representing the
   * error message, which we extract from the data passed to _callback and convert
   * to a char* string before calling the registered C callback.
   * Passing a NULL callback function to a emscripten_set_socket_*_callback call
   * will deregister the callback registered for that Event.
   */
  $_setNetworkCallback__deps: ['$withStackSave', '$callUserCallback', '$stringToUTF8OnStack'],
  $_setNetworkCallback: (event, userData, callback) => {
    function _callback(data) {
      callUserCallback(() => {
        if (event === 'error') {
          withStackSave(() => {
            var msg = stringToUTF8OnStack(data[2]);
            {{{ makeDynCall('viipp', 'callback') }}}(data[0], data[1], msg, userData);
          });
        } else {
          {{{ makeDynCall('vip', 'callback') }}}(data, userData);
        }
      });
    };

    // FIXME(sbc): This has no corresponding Pop so will currently keep the
    // runtime alive indefinitely.
    {{{ runtimeKeepalivePush() }}}
    SOCKFS.on(event, callback ? _callback : null);
  },
  emscripten_set_socket_error_callback__deps: ['$_setNetworkCallback'],
  emscripten_set_socket_error_callback: (userData, callback) =>
    _setNetworkCallback('error', userData, callback),
  emscripten_set_socket_open_callback__deps: ['$_setNetworkCallback'],
  emscripten_set_socket_open_callback: (userData, callback) =>
    _setNetworkCallback('open', userData, callback),
  emscripten_set_socket_listen_callback__deps: ['$_setNetworkCallback'],
  emscripten_set_socket_listen_callback: (userData, callback) =>
    _setNetworkCallback('listen', userData, callback),
  emscripten_set_socket_connection_callback__deps: ['$_setNetworkCallback'],
  emscripten_set_socket_connection_callback: (userData, callback) =>
    _setNetworkCallback('connection', userData, callback),
  emscripten_set_socket_message_callback__deps: ['$_setNetworkCallback'],
  emscripten_set_socket_message_callback: (userData, callback) =>
    _setNetworkCallback('message', userData, callback),
  emscripten_set_socket_close_callback__deps: ['$_setNetworkCallback'],
  emscripten_set_socket_close_callback: (userData, callback) =>
    _setNetworkCallback('close', userData, callback),
});
