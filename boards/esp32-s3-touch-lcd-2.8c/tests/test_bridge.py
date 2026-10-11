import os
import sys
from pathlib import Path
import unittest
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_bridge import Bridge, board_state, socket_path


def mood(bot, m):
    return {'event': {'type': 'bot.mood', 'bot_id': bot, 'name': 'Bot', 'mood': m}}


class BridgeTests(unittest.TestCase):
    def test_socket_path_matches_desktop_service(self):
        path = socket_path('/Users/me/Library/Application Support/Pi Bot')
        self.assertTrue(path.startswith(f'/tmp/pi-bot-{os.getuid()}-'))
        self.assertTrue(path.endswith('/service.sock'))

    def test_most_urgent_bot_wins(self):
        self.assertEqual(board_state(['thinking', 'waiting', 'working']), 'waiting')
        self.assertEqual(board_state(['searching', 'thinking']), 'searching')
        self.assertEqual(board_state(['celebrate', 'idle']), 'idle')
        self.assertEqual(board_state([]), 'idle')

    def test_moods_drive_the_board(self):
        b = Bridge(Mock(), '/tmp/pet-test')
        b.packet(mood('a', 'thinking'))
        b.board.show.assert_called_with('thinking')
        b.packet(mood('a', 'working'))
        b.board.show.assert_called_with('working')
        b.packet(mood('a', 'celebrate'))
        b.board.show.assert_called_with('success')
        b.packet(mood('a', 'idle'))
        b.board.show.assert_called_with('success')  # success is held for a few seconds

    def test_finished_bot_does_not_hide_a_busy_one(self):
        b = Bridge(Mock(), '/tmp/pet-test')
        b.packet(mood('a', 'waiting'))
        b.packet(mood('b', 'thinking'))
        b.packet(mood('b', 'error'))
        b.board.show.assert_called_with('waiting')

    def test_status_snapshot_ignores_finished_moods(self):
        b = Bridge(Mock(), '/tmp/pet-test')
        b.pending['1'] = ('status', 0)
        b.packet({'id': '1', 'result': {'activities': [
            {'botId': 'a', 'runId': 'r', 'tool': None, 'mood': 'celebrate'},
            {'botId': 'b', 'runId': 's', 'tool': 'run_command', 'mood': 'working'},
        ]}})
        self.assertEqual(b.moods, {'b': 'working'})
        b.board.show.assert_called_with('working')

    def test_long_idle_sleeps(self):
        b = Bridge(Mock(), '/tmp/pet-test')
        b.idle_since = 1
        b.show('idle')
        b.board.show.assert_called_with('sleeping')
        self.assertEqual(b.idle_since, 1)

    def test_other_events_are_ignored(self):
        b = Bridge(Mock(), '/tmp/pet-test')
        b.packet({'event': {'type': 'delta', 'content': 'private text'}})
        b.board.show.assert_not_called()


if __name__ == '__main__':
    unittest.main()
