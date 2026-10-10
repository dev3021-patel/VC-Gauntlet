"""Deflate each broadcast frame once for every WebSocket, not once per socket.

hypercorn negotiates wsproto's permessage-deflate with every browser. With the
default context takeover each socket compresses each message against its own
history, so a batch broadcast to N players costs N compressions; at 100 players
that was half the server's CPU. Declaring ``server_no_context_takeover`` (RFC
7692 section 7.1.1.1) makes a message's compressed bytes depend only on its
content, so the batch frame every subscriber shares is deflated once.
"""

from __future__ import annotations

import zlib
from collections import OrderedDict

from wsproto.extensions import PerMessageDeflate
from wsproto.frame_protocol import Opcode, RsvBits

CACHE_ENTRIES = 64
# Small private frames are not worth a cache entry.
MIN_SHARED_BYTES = 512
_compressed: OrderedDict[tuple[int, bytes], bytes] = OrderedDict()


class SharedDeflate(PerMessageDeflate):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **{**kwargs, "server_no_context_takeover": True})

    def frame_outbound(self, proto, opcode, rsv, data, fin):
        if proto.client or not fin or opcode not in (Opcode.TEXT, Opcode.BINARY) or len(data) < MIN_SHARED_BYTES:
            return super().frame_outbound(proto, opcode, rsv, data, fin)
        key = (self.server_max_window_bits, bytes(data))
        compressed = _compressed.get(key)
        if compressed is None:
            compressor = zlib.compressobj(zlib.Z_DEFAULT_COMPRESSION, zlib.DEFLATED, -int(self.server_max_window_bits))
            # A message ends with an empty sync-flushed block whose 4 trailing bytes are implied.
            compressed = _compressed[key] = (compressor.compress(key[1]) + compressor.flush(zlib.Z_SYNC_FLUSH))[:-4]
            if len(_compressed) > CACHE_ENTRIES:
                _compressed.popitem(last=False)
        return RsvBits(True, rsv[1], rsv[2]), compressed


def install() -> None:
    """Make hypercorn offer the shared compressor; call before serving."""
    from hypercorn.protocol import ws_stream

    ws_stream.PerMessageDeflate = SharedDeflate
