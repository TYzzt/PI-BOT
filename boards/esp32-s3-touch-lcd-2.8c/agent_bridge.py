"""Follow Pi Bot's authenticated local event stream and animate the USB buddy.

Only state names are sent to the board. Messages, tool arguments, and tokens are
never printed or transmitted to the microcontroller.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import socket
import time
import uuid

import serial

STATES = ('idle', 'thinking', 'working', 'searching', 'waiting', 'success', 'error', 'sleeping')
# Pi Bot moods (packages/bot-face) → board states.
MOOD_STATE = {
    'idle': 'idle', 'happy': 'idle', 'sleeping': 'idle',
    'thinking': 'thinking', 'working': 'working', 'searching': 'searching',
    'waiting': 'waiting', 'celebrate': 'success', 'error': 'error',
}
ACTIVE = ('waiting', 'working', 'searching', 'thinking')


def board_state(moods):
    """The most urgent active state across all bots running on this Mac."""
    states = {MOOD_STATE.get(m, 'idle') for m in moods}
    return next((s for s in ACTIVE if s in states), 'idle')


class Board:
    def __init__(self, port):
        self.uart = serial.Serial(port=None, baudrate=115200, timeout=0, write_timeout=2)
        self.uart.dtr = False
        self.uart.rts = False
        self.uart.port = port
        self.uart.open()
        self.state = None

    def send(self, command):
        self.uart.write((command + '\n').encode('ascii'))

    def show(self, state):
        if state != self.state:
            self.send('STATE ' + state)
            self.state = state
            print('Buddy: ' + state, flush=True)

    def heartbeat(self):
        self.send('PING')
        # Drain board logs so UART buffers cannot grow without bound.
        output = self.uart.read(16384)
        if b'PET ready' in output and self.state:
            self.send('STATE ' + self.state)

    def close(self):
        self.uart.close()


def socket_path(data_dir):
    digest = hashlib.sha256(str(data_dir).encode()).hexdigest()[:12]
    return f'/tmp/pi-bot-{os.getuid()}-{digest}/service.sock'


class Bridge:
    def __init__(self, board, data_dir):
        self.board = board
        self.data_dir = Path(data_dir)
        self.socket_path = socket_path(self.data_dir)
        self.pending = {}
        self.buffer = b''
        self.moods = {}
        self.hold_until = 0
        self.idle_since = time.monotonic()
        self.last_status = 0

    def request(self, method, input_data=None):
        request_id = str(uuid.uuid4())
        self.pending[request_id] = (method, time.monotonic())
        self.sock.sendall((json.dumps({'id': request_id, 'method': method, 'input': input_data or {}}) + '\n').encode())

    def show(self, state, hold=False):
        now = time.monotonic()
        if state in {'idle', 'sleeping'}:
            if now < self.hold_until:
                return
            if now - self.idle_since > 60:
                state = 'sleeping'
        else:
            self.idle_since = now
            self.hold_until = now + 5 if hold else 0
        self.board.show(state)

    def refresh(self):
        self.show(board_state(self.moods.values()))

    def event(self, event):
        if event.get('type') != 'bot.mood':
            return
        bot, mood = event.get('bot_id'), event.get('mood')
        state = MOOD_STATE.get(mood, 'idle')
        if state in ACTIVE:
            self.moods[bot] = mood
            self.refresh()
            return
        self.moods.pop(bot, None)
        busy = board_state(self.moods.values())
        if state in {'success', 'error'} and busy == 'idle':
            self.show(state, hold=True)
        else:
            self.show(busy)

    def packet(self, packet):
        if packet.get('ready'):
            print('Pi Bot connected (read-only event subscription)', flush=True)
            self.request('status')
        elif 'event' in packet:
            self.event(packet['event'])
        elif packet.get('id') in self.pending:
            method, _ = self.pending.pop(packet['id'])
            if 'error' in packet:
                return  # Never echo service error bodies or private data.
            if method == 'status':
                # Finished runs keep their last mood in the snapshot; only live ones count.
                activities = (packet.get('result') or {}).get('activities') or []
                self.moods = {a['botId']: a['mood'] for a in activities if MOOD_STATE.get(a.get('mood')) in ACTIVE}
                self.refresh()

    def run_connected(self):
        self.pending.clear()
        self.buffer = b''
        self.hold_until = 0
        self.idle_since = time.monotonic()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as self.sock:
            self.sock.settimeout(3)
            self.sock.connect(self.socket_path)
            token = (self.data_dir / 'ipc-token').read_text()
            self.sock.sendall((json.dumps({'token': token}) + '\n').encode())
            authenticated = False
            auth_deadline = time.monotonic() + 5
            while True:
                now = time.monotonic()
                if not authenticated and now > auth_deadline:
                    raise ConnectionError('Authentication timeout')
                if authenticated and now - self.last_status > 2:
                    self.request('status')
                    self.last_status = now
                    self.board.heartbeat()
                if any(now - item[1] > 15 for item in self.pending.values()):
                    raise ConnectionError('Service request timeout')
                readable, _, _ = select.select([self.sock], [], [], .2)
                if not readable:
                    continue
                chunk = self.sock.recv(65536)
                if not chunk:
                    raise ConnectionError('Service disconnected')
                self.buffer += chunk
                if len(self.buffer) > 8_000_000:
                    raise ConnectionError('Service packet too large')
                while b'\n' in self.buffer:
                    line, self.buffer = self.buffer.split(b'\n', 1)
                    packet = json.loads(line)
                    authenticated |= bool(packet.get('ready'))
                    self.packet(packet)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', default='/dev/cu.usbmodem5B910686821')
    parser.add_argument('--data-dir', default=os.environ.get('PI_BOT_DATA_DIR', str(Path.home() / 'Library/Application Support/Pi Bot')))
    parser.add_argument('--state', choices=STATES, help='Send one state instead of following Pi Bot')
    parser.add_argument('--demo', action='store_true', help='Restore board demo cycle')
    args = parser.parse_args()
    try:
        while True:
            board = None
            try:
                board = Board(args.port)
                if args.demo:
                    board.send('DEMO')
                    return
                if args.state:
                    board.show(args.state)
                    return
                bridge = Bridge(board, args.data_dir)
                announced = False
                while True:
                    try:
                        bridge.run_connected()
                    except (OSError, ValueError, ConnectionError):
                        board.show('waiting')
                        board.heartbeat()
                        if not announced:
                            print('Waiting for Pi Bot local service; retrying.', flush=True)
                            announced = True
                        time.sleep(2)
            except (serial.SerialException, OSError):
                if args.state or args.demo:
                    raise
                print('USB unavailable; retrying in 2 seconds.', flush=True)
                time.sleep(2)
            finally:
                if board:
                    board.close()
    except KeyboardInterrupt:
        print('Buddy bridge stopped.', flush=True)


if __name__ == '__main__':
    main()
