"""Hardware smoke test: resets board, checks all states and parser recovery."""
import argparse
import time
import serial
from esptool.reset import HardReset

parser=argparse.ArgumentParser()
parser.add_argument('--port',default='/dev/cu.usbmodem5B910686821')
args=parser.parse_args()
uart=serial.Serial(port=None,baudrate=115200,timeout=.1)
uart.dtr=False
uart.rts=False
uart.port=args.port
uart.open()

def collect(seconds):
    end=time.monotonic()+seconds
    buffer=b''
    while time.monotonic()<end:
        buffer+=uart.read(8192)
    text=buffer.decode('utf8',errors='replace')
    print(text,end='',flush=True)
    assert 'Guru Meditation' not in text and 'panic' not in text,text
    return text

try:
    HardReset(uart)()
    boot=collect(4)
    assert 'PET ready states=8 protocol=1' in boot,boot
    for state in ['idle','thinking','working','searching','waiting','success','error','sleeping']:
        uart.write(('STATE '+state+'\n').encode())
        text=collect(.8)
        assert 'PET ack='+state in text,(state,text)
        uart.write(b'STATUS\n')
        text=collect(.4)
        assert 'PET status='+state in text,(state,text)
    uart.write(b'STATE invalid\n'+b'x'*80+b'\nSTATUS\n')
    text=collect(1)
    assert 'unknown-state' in text and 'command-too-long' in text,text
    for i in range(5):
        uart.write(b'PING\nSTATUS\n')
        collect(2)
    uart.write(b'DEMO\n')
    collect(.5)
    print('PASS: boot, 8 state ACKs, parser recovery, sustained animation')
finally:
    uart.close()
