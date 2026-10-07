"""Print UART output for a bounded period; do not assert DTR/RTS."""
import argparse
import time
import serial

parser = argparse.ArgumentParser()
parser.add_argument('--port', default='/dev/cu.usbmodem5B910686821')
parser.add_argument('--seconds', type=float, default=15)
args = parser.parse_args()
uart = serial.Serial(port=None, baudrate=115200, timeout=0.5)
uart.dtr = False
uart.rts = False
uart.port = args.port
with uart:
    end = time.monotonic() + args.seconds
    while time.monotonic() < end:
        print(uart.read(4096).decode('utf-8', errors='replace'), end='', flush=True)
