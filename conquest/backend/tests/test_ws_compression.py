"""Shared deflate output must decode exactly like per-socket permessage-deflate."""

import zlib

from wsproto.frame_protocol import Opcode, RsvBits

from app.ws_compression import SharedDeflate


def test_broadcast_frames_are_deflated_once_and_decode_for_every_socket():
    class Server:
        client = False

    frame = ('{"type":"batch","events":[' + ",".join(f'{{"revision":{n}}}' for n in range(200)) + "]}").encode()
    sockets = [SharedDeflate() for _ in range(3)]
    assert sockets[0].accept("permessage-deflate; client_max_window_bits") == (
        "server_no_context_takeover; client_max_window_bits=15"
    )
    outputs = [socket.frame_outbound(Server(), Opcode.TEXT, RsvBits(False, False, False), frame, True) for socket in sockets]
    assert all(rsv.rsv1 for rsv, _ in outputs)
    assert outputs[1][1] is outputs[0][1] is outputs[2][1]
    # Each message decodes on its own, as a client honouring server_no_context_takeover does.
    for _ in range(2):
        assert zlib.decompressobj(-15).decompress(outputs[0][1] + b"\x00\x00\xff\xff") == frame
