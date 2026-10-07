import sys
from pathlib import Path
import unittest
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_bridge import Bridge, detail_state

class BridgeTests(unittest.TestCase):
    def test_planning_finished_waits_for_review(self):
        self.assertEqual(detail_state({'task': {'state': 'awaiting_review'}}, True), 'waiting')

    def test_old_failed_tool_does_not_poison_new_run(self):
        data={'task': {'state':'executing','activeRunId':'new'},'tools':[{'state':'running','runId':'old','name':'write_file'}]}
        self.assertEqual(detail_state(data),'thinking')

    def test_parallel_write_takes_priority_over_read(self):
        data={'task':{'state':'executing','activeRunId':'r'},'tools':[{'state':'running','runId':'r','name':n} for n in ['read_file','write_file']]}
        self.assertEqual(detail_state(data),'working')
        data['tools']=data['tools'][:1]
        self.assertEqual(detail_state(data),'searching')

    def test_browser_operations_search(self):
        data={'task':{'state':'executing','activeRunId':'r'},'tools':[{'state':'running','runId':'r','name':'browser_task'}]}
        self.assertEqual(detail_state(data),'searching')

    def test_old_completion_not_replayed_at_start(self):
        self.assertEqual(detail_state({'task':{'state':'completed'}}),'idle')
        self.assertEqual(detail_state({'task':{'state':'completed'}},True),'success')

    def test_run_start_clears_completion_hold(self):
        b=Bridge(Mock(),'/tmp/pet-test')
        b.hold_until=9999999999
        b.waiting=True
        b.event({'type':'run.started','conversation_id':'c'})
        self.assertTrue(b.active)
        self.assertEqual(b.hold_until,0)
        self.assertFalse(b.waiting)
        b.board.show.assert_called_with('thinking')

    def test_sleeping_does_not_restart_idle_timer(self):
        b=Bridge(Mock(),'/tmp/pet-test')
        b.idle_since=1
        b.show('sleeping')
        self.assertEqual(b.idle_since,1)

    def test_real_event_packet_routes_once(self):
        b=Bridge(Mock(),'/tmp/pet-test')
        b.packet({'event':{'type':'run.started','conversation_id':'c'}})
        b.board.show.assert_called_once_with('thinking')
        b.packet({'event':{'type':'message.delta','content':'private prompt'}})
        b.board.show.assert_called_with('thinking')

if __name__=='__main__': unittest.main()
