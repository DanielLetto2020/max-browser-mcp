import importlib.util
import io
import json
import os
import pathlib
import socket
import struct
import tempfile
import threading
import unittest
from unittest import mock

path = pathlib.Path(__file__).resolve().parents[1] / 'bridge.py'
spec = importlib.util.spec_from_file_location('bridge', path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ToolValidation(unittest.TestCase):
    def test_all_tools_have_unique_names_and_valid_required_fields(self):
        self.assertEqual(len(bridge.TOOLS), len({tool[0] for tool in bridge.TOOLS}))
        for name, _, props, required in bridge.TOOLS:
            self.assertTrue(set(required) <= set(props), name)

    def test_all_tool_parameters_have_descriptions(self):
        for name, desc, props, _ in bridge.TOOLS:
            self.assertTrue(bool(desc), name)
            built = bridge.schema(props, [])['properties']
            for k, pspec in built.items():
                self.assertIn('description', pspec, f'{name}.{k} missing description')
                self.assertTrue(len(pspec['description']) >= 5, f'{name}.{k} empty description')

    def test_semantic_targets_and_frame_are_accepted(self):
        bridge.validate_tool('click', {'tabId': 1, 'frameId': 2, 'role': 'button', 'name': 'Save',
                                      'expect': {'selector': '#result', 'textIncludes': 'Saved'}})
        bridge.validate_tool('fill', {'tabId': 1, 'ref': 'e2', 'value': 'hello'})
        bridge.validate_tool('insert_text', {'tabId': 1, 'text': 'hello'})

    def test_invalid_inputs_rejected_before_browser_call(self):
        for name, args in [('click', {'tabId': 1}), ('click', {'tabId': True, 'selector': 'button'}),
                           ('tabs_move', {'tabId': 1}), ('tabs_move', {'tabId': 1, 'index': 0, 'offset': -1}),
                           ('tabs_reorder', {'tabIds': [1, 1]}), ('wait_page', {'tabId': 1, 'timeoutMs': 30001}),
                           ('screenshot', {'tabId': 1, 'scale': 0}), ('fill', {'tabId': 1, 'selector': 'input', 'value': 9})]:
            with self.subTest(name=name, args=args), self.assertRaises(ValueError):
                bridge.validate_tool(name, args)
        for expected in [{}, {'value': 'ignored'}, {'state': 'visible', 'urlIncludes': 'example'}]:
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                bridge.validate_tool('click', {'tabId': 1, 'selector': 'button', 'expect': expected})

    def test_download_paths_cannot_escape_downloads(self):
        for filename in ['/tmp/a', '../a', 'nested/../../a', '']:
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                bridge.validate_tool('download_start', {'url': 'https://example.com/a', 'filename': filename})
        bridge.validate_tool('download_start', {'url': 'https://example.com/a', 'filename': 'nested/a'})

    def test_upload_requires_existing_absolute_files_and_blocks_sensitive_paths(self):
        with tempfile.NamedTemporaryFile() as file:
            bridge.validate_tool('upload_files', {'tabId': 1, 'selector': 'input', 'files': [file.name]})
        with self.assertRaises(ValueError):
            bridge.validate_tool('upload_files', {'tabId': 1, 'selector': 'input', 'files': ['/nonexistent/file']})
        if pathlib.Path('/etc/passwd').is_file():
            with self.assertRaises(ValueError):
                bridge.validate_tool('upload_files', {'tabId': 1, 'selector': 'input', 'files': ['/etc/passwd']})
        with tempfile.TemporaryDirectory() as tmp:
            ssh_dir = pathlib.Path(tmp) / '.ssh'
            ssh_dir.mkdir()
            key = ssh_dir / 'id_rsa'
            key.write_text('dummy')
            with self.assertRaises(ValueError):
                bridge.validate_tool('upload_files', {'tabId': 1, 'selector': 'input', 'files': [str(key)]})
            with mock.patch.dict(os.environ, {'MAX_BROWSER_ALLOW_SENSITIVE_UPLOAD': '1'}):
                bridge.validate_tool('upload_files', {'tabId': 1, 'selector': 'input', 'files': [str(key)]})

    def test_v13_tools_and_optional_tab_id(self):
        bridge.validate_tool('page_snapshot', {'format': 'tree', 'filter': 'interactive', 'depth': 5, 'maxChars': 10000})
        bridge.validate_tool('find_elements', {'query': 'Save button'})
        bridge.validate_tool('click', {'coordinate': [120, 240], 'button': 'right', 'clickCount': 2, 'modifiers': 'ctrl+shift'})
        bridge.validate_tool('hover', {'coordinate': [10, 20]})
        bridge.validate_tool('drag', {'startCoordinate': [10, 20], 'coordinate': [100, 200]})
        bridge.validate_tool('scroll', {'coordinate': [50, 50], 'direction': 'down', 'amount': 5})
        bridge.validate_tool('press_key', {'key': 'ctrl+a', 'modifiers': 'shift'})
        bridge.validate_tool('handle_dialog', {'accept': True, 'promptText': 'ok'})
        bridge.validate_tool('resize_window', {'width': 1280, 'height': 800})
        bridge.validate_tool('screenshot', {'region': [0, 0, 400, 300], 'format': 'jpeg', 'quality': 70})
        bridge.validate_tool('diagnostics_get', {'autoStart': True, 'onlyErrors': True, 'pattern': 'error|warn', 'urlPattern': '/api/'})
        bridge.validate_tool('batch', {'actions': [
            {'name': 'fill', 'arguments': {'selector': '#name', 'value': 'hi'}},
            {'name': 'click', 'arguments': {'role': 'button', 'name': 'Save'}},
            {'name': 'screenshot', 'arguments': {}}
        ]})

        with self.assertRaises(ValueError):
            bridge.validate_tool('tabs_close', {})
        with self.assertRaises(ValueError):
            bridge.validate_tool('find_elements', {})
        with self.assertRaises(ValueError):
            bridge.validate_tool('batch', {'actions': [{'name': 'batch', 'arguments': {'actions': []}}]})
        with self.assertRaises(ValueError):
            bridge.validate_tool('batch', {'actions': [{'name': 'click', 'arguments': {}}]})

    def test_v14_and_v15_tools_validation(self):
        bridge.validate_tool('emulate', {'width': 375, 'height': 812, 'mobile': True, 'colorScheme': 'dark'})
        bridge.validate_tool('emulate', {'userAgent': 'CustomUA/1.0', 'locale': 'ru-RU', 'timezone': 'Europe/Moscow'})
        bridge.validate_tool('emulate', {'reset': True})
        bridge.validate_tool('route_mock', {'urlPattern': '*/api/*', 'status': 500, 'body': '{"err":1}', 'delayMs': 100})
        bridge.validate_tool('route_clear', {})
        bridge.validate_tool('audit_layout', {'maxIssues': 25})
        bridge.validate_tool('wait', {'ms': 250})
        bridge.validate_tool('storage_get', {'type': 'both', 'redact': True})
        bridge.validate_tool('storage_set', {'type': 'local', 'key': 'theme', 'value': 'dark'})
        bridge.validate_tool('storage_set', {'clear': True})
        bridge.validate_tool('cookies_list', {'redact': True})
        bridge.validate_tool('screenshot', {'annotate': True, 'annotateLimit': 40})
        bridge.validate_tool('page_snapshot', {'diff': True})
        bridge.validate_tool('diagnostics_start', {'captureBodies': True, 'maxBodyChars': 4096})
        bridge.validate_tool('wait_for', {'selector': '#btn', 'visible': True, 'stableMs': 300})
        bridge.validate_tool('click', {'selector': '#btn', 'actionTimeoutMs': 1500, 'checkOcclusion': True, 'fast': True})
        bridge.validate_tool('read_dom', {'selector': '#main', 'maxChars': 2000})
        bridge.validate_tool('fill', {'selector': '#phone', 'value': '9991234567', 'strict': False})
        bridge.validate_tool('drag', {'startSelector': '#a', 'targetSelector': '#b'})
        bridge.validate_tool('drag', {'startRef': 'r1', 'targetRef': 'r2'})
        bridge.validate_tool('insert_text', {'targetText': 'Search', 'text': 'query'})
        bridge.validate_tool('batch', {'animate': False, 'keepDebugger': True, 'actions': [{'name': 'wait', 'arguments': {'ms': 10}}]})
        with self.assertRaises(ValueError):
            bridge.validate_tool('emulate', {})
        with self.assertRaises(ValueError):
            bridge.validate_tool('emulate', {'latitude': 55.75})
        with self.assertRaises(ValueError):
            bridge.validate_tool('storage_set', {'type': 'local'})
        with self.assertRaises(ValueError):
            bridge.validate_tool('insert_text', {'text': 'hello', 'nth': 0})
        with self.assertRaises(ValueError):
            bridge.validate_tool('drag', {'startSelector': '#a'})

    def test_compute_timeout_scales_with_wait_arguments(self):
        self.assertEqual(bridge.compute_timeout('click', {'selector': '#a'}), 45.0)
        self.assertGreaterEqual(bridge.compute_timeout('wait_for', {'selector': '#a', 'timeoutMs': 30000}), 50.0)
        self.assertEqual(bridge.compute_timeout('click', {
            'selector': '#a',
            'actionTimeoutMs': 10000,
            'expect': {'selector': '#b', 'timeoutMs': 30000}
        }), 60.0)
        self.assertLessEqual(bridge.compute_timeout('wait', {'ms': 30000, 'timeoutMs': 30000, 'actionTimeoutMs': 10000, 'expect': {'timeoutMs': 30000}}), 120.0)

    def test_batch_mcp_content_interleaves_screenshots(self):
        content = bridge.format_mcp_content('batch', {
            'steps': [
                {'step': 1, 'tool': 'click', 'ok': True, 'result': {'clicked': True}},
                {'step': 2, 'tool': 'screenshot', 'ok': True, 'result': {'image': 'AAAA', 'mimeType': 'image/jpeg', 'width': 800, 'height': 600}},
            ]
        })
        self.assertEqual([c['type'] for c in content], ['text', 'text', 'image'])
        self.assertEqual(content[2]['data'], 'AAAA')

    def test_mcp_initialize_handles_missing_protocol_version(self):
        reqs = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}}) + '\n'
        out = io.StringIO()
        with mock.patch('sys.stdin', io.StringIO(reqs)), mock.patch('sys.stdout', out):
            bridge.mcp()
        resp = json.loads(out.getvalue().strip())
        self.assertEqual(resp['result']['protocolVersion'], '2024-11-05')
        self.assertEqual(resp['result']['serverInfo']['version'], bridge.VERSION)

    def test_mcp_dispatches_tool_calls_concurrently(self):
        started = threading.Event()
        second_ran = threading.Event()

        def fake_browser(name, args):
            if args.get('key') == 'first':
                started.set()
                self.assertTrue(second_ran.wait(2.0), 'second call was blocked by first')
                return {'order': 1}
            started.wait(2.0)
            second_ran.set()
            return {'order': 2}

        reqs = (
            json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'press_key', 'arguments': {'key': 'first'}}}) + '\n' +
            json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'press_key', 'arguments': {'key': 'second'}}}) + '\n'
        )
        out = io.StringIO()
        with mock.patch.object(bridge, 'browser', side_effect=fake_browser), \
             mock.patch('sys.stdin', io.StringIO(reqs)), \
             mock.patch('sys.stdout', out):
            bridge.mcp()
        lines = [json.loads(line) for line in out.getvalue().strip().splitlines()]
        self.assertEqual({l['id'] for l in lines}, {1, 2})
        self.assertTrue(all(not l['result'].get('isError') for l in lines))

    def test_v20_tools_and_schemas(self):
        self.assertEqual(len(bridge.TOOLS), 83)
        self.assertIn('extension_reload', {t[0] for t in bridge.TOOLS})
        bridge.validate_tool('extension_reload', {'waitForReconnect': True})
        bridge.validate_tool('cookies_set', {'name': 'sid', 'value': 'v1', 'httpOnly': True, 'sameSite': 'lax'})
        bridge.validate_tool('cookies_delete', {'name': 'sid'})
        bridge.validate_tool('clipboard_read', {'maxChars': 2000})
        bridge.validate_tool('clipboard_write', {'text': 'hello'})
        bridge.validate_tool('print_to_pdf', {'landscape': True, 'printBackground': True, 'savePath': '/tmp/out.pdf'})
        bridge.validate_tool('wait_network', {'urlPattern': '*/api/*', 'method': 'POST', 'status': 200, 'captureBody': True})
        bridge.validate_tool('wait_tab', {'urlIncludes': 'example.com', 'timeoutMs': 5000})
        bridge.validate_tool('windows_list', {'populate': True})
        bridge.validate_tool('get_styles', {'selector': '#btn', 'properties': ['color', 'display']})
        bridge.validate_tool('highlight_element', {'selector': '#btn', 'color': '#10b981', 'durationMs': 1500})
        bridge.validate_tool('highlight_element', {'clear': True})
        bridge.validate_tool('audit_responsive', {'widths': [375, 1280], 'height': 800})
        bridge.validate_tool('performance_metrics', {})
        bridge.validate_tool('safety_config', {})
        bridge.validate_tool('recorder_control', {'action': 'start'})
        bridge.validate_tool('click', {'mark': 3, 'onDialog': 'accept', 'dialogPromptText': 'ok'})
        bridge.validate_tool('navigate', {'url': 'https://example.com', 'onDialog': 'dismiss'})
        bridge.validate_tool('route_mock', {'urlPattern': '*/api/*', 'stage': 'response', 'patchJson': {'ok': True}})
        bridge.validate_tool('route_mock', {'urlPattern': '*/api/*', 'failReason': 'TimedOut'})
        bridge.validate_tool('screenshot', {'tiles': True, 'maxTiles': 4, 'savePath': '/tmp/shot.jpg'})
        bridge.validate_tool('page_snapshot', {'compactLists': False})
        with self.assertRaises(ValueError):
            bridge.validate_tool('get_styles', {})
        with self.assertRaises(ValueError):
            bridge.validate_tool('highlight_element', {})
        with self.assertRaises(ValueError):
            bridge.validate_tool('print_to_pdf', {'savePath': '/etc/passwd'})

    def test_batch_template_variables_and_retries(self):
        attempts = {'click': 0}

        def fake_send(name, args, meta=None, timeout_sec=None):
            if name == 'find_elements':
                return {'matches': [{'ref': 'r-e42', 'name': 'Save'}]}
            if name == 'click':
                attempts['click'] += 1
                if attempts['click'] == 1:
                    raise RuntimeError('transient glitch')
                return {'clicked': True, 'usedRef': args.get('ref')}
            return {'ok': True}

        with mock.patch.object(bridge, '_send_browser', side_effect=fake_send):
            res = bridge.browser('batch', {'serverSide': False, 'actions': [
                {'name': 'find_elements', 'arguments': {'query': 'Save'}},
                {'name': 'click', 'arguments': {'ref': '{{$step1.matches[0].ref}}'}, 'retries': 1, 'retryDelayMs': 50},
            ]})
        self.assertEqual(res['completed'], 2)
        self.assertEqual(attempts['click'], 2)
        self.assertEqual(res['steps'][1]['result']['usedRef'], 'r-e42')

    def test_save_path_writes_pdf_and_screenshot_tiles(self):
        import base64
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = pathlib.Path(tmp) / 'doc.pdf'
            with mock.patch.object(bridge, '_send_browser', return_value={'data': base64.b64encode(b'%PDF-1.4').decode(), 'mimeType': 'application/pdf'}):
                pdf_res = bridge.browser('print_to_pdf', {'savePath': str(pdf_path)})
            self.assertEqual(pdf_path.read_bytes(), b'%PDF-1.4')
            self.assertNotIn('data', pdf_res)

            shot_path = pathlib.Path(tmp) / 'page.jpg'
            tiles_payload = {
                'tiles': [
                    {'image': base64.b64encode(b'IMG1').decode(), 'mimeType': 'image/jpeg', 'scrollY': 0},
                    {'image': base64.b64encode(b'IMG2').decode(), 'mimeType': 'image/jpeg', 'scrollY': 700},
                ],
                'count': 2,
            }
            with mock.patch.object(bridge, '_send_browser', return_value=tiles_payload):
                shot_res = bridge.browser('screenshot', {'tiles': True, 'savePath': str(shot_path)})
            self.assertEqual(len(shot_res['savedFiles']), 2)
            self.assertEqual((pathlib.Path(tmp) / 'page-tile-1.jpg').read_bytes(), b'IMG1')
            self.assertNotIn('image', shot_res['tiles'][0])

    def test_batch_sends_lease_and_releases(self):
        sent_calls = []

        def fake_send(name, args, meta=None, timeout_sec=None):
            sent_calls.append((name, args, meta))
            return {'ok': True}

        with mock.patch.object(bridge, '_send_browser', side_effect=fake_send):
            res = bridge.browser('batch', {'serverSide': False, 'actions': [
                {'name': 'click', 'arguments': {'selector': '#a'}},
                {'name': 'fill', 'arguments': {'selector': '#b', 'value': 'x'}},
            ]})
        self.assertEqual(res['completed'], 2)
        self.assertEqual(sent_calls[0][0], 'click')
        self.assertTrue(sent_calls[0][2]['fast'])
        self.assertGreater(sent_calls[0][2]['leaseMs'], 0)
        self.assertEqual(sent_calls[-1][0], '_release_leases')

    def test_native_reassembles_chunked_messages_over_unix_socket(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            sock_path = pathlib.Path(tmpdir) / 'browser.sock'
            stdin_r, stdin_w = os.pipe()
            stdout_r, stdout_w = os.pipe()

            def run_native():
                with mock.patch.object(bridge, 'BASE', pathlib.Path(tmpdir)), \
                     mock.patch.object(bridge, 'SOCKET', str(sock_path)), \
                     mock.patch('sys.stdin', io.TextIOWrapper(os.fdopen(stdin_r, 'rb'))), \
                     mock.patch('sys.stdout', io.TextIOWrapper(os.fdopen(stdout_w, 'wb'))), \
                     mock.patch('os._exit', side_effect=SystemExit):
                    try:
                        bridge.native()
                    except SystemExit:
                        pass

            t = threading.Thread(target=run_native, daemon=True)
            t.start()
            for _ in range(30):
                if sock_path.exists():
                    break
                threading.Event().wait(0.02)
            self.assertTrue(sock_path.exists())

            def echo_host():
                head = os.read(stdout_r, 4)
                size = struct.unpack('<I', head)[0]
                req = json.loads(os.read(stdout_r, size))
                full = json.dumps({'id': req['id'], 'result': {'payload': 'X' * 5000}})
                mid = len(full) // 2
                for idx, part in enumerate([full[:mid], full[mid:]]):
                    msg = json.dumps({'id': req['id'], '__chunk': idx, '__total': 2, 'data': part}).encode()
                    os.write(stdin_w, struct.pack('<I', len(msg)) + msg)
                os.close(stdin_w)

            ht = threading.Thread(target=echo_host, daemon=True)
            ht.start()
            with mock.patch.object(bridge, 'SOCKET', str(sock_path)):
                result = bridge.browser('tabs_list', {})
            self.assertEqual(len(result['payload']), 5000)
            ht.join(timeout=2)
            t.join(timeout=2)
            try:
                os.close(stdout_r)
            except OSError:
                pass

    def test_v30_profiles_cut_token_footprint(self):
        full_tools = bridge.get_profile_tools('full')
        core_tools = bridge.get_profile_tools('core')
        qa_tools = bridge.get_profile_tools('qa')
        self.assertEqual(len(full_tools), 83)
        self.assertEqual(len(core_tools), 24)
        self.assertGreater(len(qa_tools), len(core_tools))
        full_sz = len(json.dumps([{'name': n, 'description': d, 'inputSchema': bridge.schema(p, r)} for n, d, p, r in full_tools]))
        core_sz = len(json.dumps([{'name': n, 'description': d, 'inputSchema': bridge.schema(p, r)} for n, d, p, r in core_tools]))
        self.assertLess(core_sz, full_sz * 0.5)

        reqs = (
            json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}}) + '\n' +
            json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'get_styles', 'arguments': {'selector': '#a'}}}) + '\n'
        )
        out = io.StringIO()
        with mock.patch.object(bridge, 'browser', return_value={'styles': {'color': 'red'}}), \
             mock.patch('sys.stdin', io.StringIO(reqs)), \
             mock.patch('sys.stdout', out):
            bridge.mcp(profile='core')
        resps = {r['id']: r for r in (json.loads(line) for line in out.getvalue().strip().splitlines())}
        self.assertEqual(len(resps[1]['result']['tools']), 24)
        self.assertFalse(resps[2]['result'].get('isError'))

    def test_v30_tools_validation_and_paths(self):
        bridge.validate_tool('browser_config', {'speedMode': 'instant', 'compactResponses': True, 'defaultScreenshotPreset': 'fast', 'idleDebuggerLeaseMs': 4000})
        bridge.validate_tool('extract_structured', {'rowSelector': '.card', 'fields': {'title': 'h3', 'href': 'a@href'}})
        bridge.validate_tool('fill_form', {'fields': {'Имя': 'Макс', 'Оферта': True}, 'submit': 'Отправить', 'afterSnapshot': 'diff'})
        bridge.validate_tool('page_fetch', {'url': '/api/items', 'method': 'POST', 'body': {'a': 1}})
        bridge.validate_tool('session_state', {'action': 'export', 'slot': 'admin'})
        bridge.validate_tool('scroll_to_text', {'text': 'Конец', 'stepPx': 400, 'maxSteps': 10})
        bridge.validate_tool('accessibility_audit', {'maxIssues': 20})
        bridge.validate_tool('visual_diff', {'action': 'capture_baseline', 'slot': 'hero'})
        bridge.validate_tool('wait_until_js', {'expression': 'window.ready === true', 'quietMs': 250})
        bridge.validate_tool('network_har_export', {'urlPattern': '*/api/*', 'limit': 50})
        bridge.validate_tool('replay_request', {'urlPattern': '*/api/echo*', 'method': 'POST'})
        bridge.validate_tool('bookmarks_and_history', {'query': 'docs', 'source': 'both'})
        bridge.validate_tool('page_markdown', {'mainOnly': True, 'maxChars': 10000})
        bridge.validate_tool('screenshot', {'preset': 'fast', 'dedupe': True, 'grid': True, 'gridStep': 80})
        bridge.validate_tool('page_snapshot', {'viewportOnly': True, 'skipLandmarks': ['nav', 'footer']})
        bridge.validate_tool('get_page_text', {'grep': 'price', 'around': 2})
        bridge.validate_tool('diagnostics_get', {'summaryOnly': True})
        bridge.validate_tool('navigate', {'url': 'https://example.com', 'dismissCookies': True, 'afterSnapshot': 'interactive'})
        bridge.validate_tool('click', {'selector': '#ok', 'compact': True, 'afterSnapshot': 'diff'})
        for bad_tool, bad_args in [
            ('scroll_to_text', {}),
            ('wait_until_js', {}),
            ('replay_request', {}),
            ('network_har_export', {'savePath': '/etc/passwd'}),
            ('session_state', {'action': 'export', 'savePath': '/home/u/.ssh/id_rsa'}),
            ('visual_diff', {'action': 'compare', 'savePath': '/home/u/.aws/credentials'}),
        ]:
            with self.assertRaises(ValueError):
                bridge.validate_tool(bad_tool, bad_args)

    def test_v30_server_side_batch_and_parallel_validation(self):
        sent = []
        def fake_send(name, args, meta=None, timeout_sec=None):
            sent.append((name, args, meta))
            return {'steps': [{'step': 1, 'tool': 'fill', 'ok': True}], 'completed': 1, 'total': 1, 'hadError': False}

        with mock.patch.object(bridge, '_send_browser', side_effect=fake_send):
            res = bridge.browser('batch', {
                'afterSnapshot': 'diff',
                'compact': True,
                'actions': [
                    {'name': 'fill', 'arguments': {'selector': '#a', 'value': '1'}, 'when': {'selector': '#a'}},
                    {'parallel': [
                        {'name': 'wait', 'arguments': {'ms': 10}},
                        {'name': 'get_page_text', 'arguments': {}},
                    ]},
                    {'name': 'click', 'arguments': {'selector': '#opt'}, 'optional': True, 'repeatUntil': {'selector': '#done', 'maxIterations': 3}},
                ],
            })
        self.assertEqual(sent[0][0], '_batch_exec')
        self.assertFalse(res['hadError'])
        with self.assertRaises(ValueError):
            bridge.validate_tool('batch', {'actions': [{'parallel': [{'name': 'batch', 'arguments': {'actions': []}}]}]})
        with self.assertRaises(ValueError):
            bridge.validate_tool('batch', {'actions': [{'name': 'click', 'parallel': [{'name': 'click'}]}]})

    def test_v30_local_file_io_and_mcp_visual_diff(self):
        import base64
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = pathlib.Path(tmp)
            sess_file = tmp_p / 'sess.json'
            with mock.patch.object(bridge, '_send_browser', return_value={'exported': True, 'slot': 's1', 'cookieCount': 1, 'data': {'cookies': [{'name': 'k', 'value': 'v'}]}}) as m_send:
                exp = bridge.browser('session_state', {'action': 'export', 'savePath': str(sess_file)})
            self.assertTrue(m_send.call_args.args[1].get('returnData'))
            self.assertNotIn('data', exp)
            self.assertTrue(sess_file.is_file())
            self.assertEqual(json.loads(sess_file.read_text())['cookies'][0]['name'], 'k')

            with mock.patch.object(bridge, '_send_browser', return_value={'imported': True}) as m_imp:
                bridge.browser('session_state', {'action': 'import', 'filePath': str(sess_file)})
            self.assertIn('data', m_imp.call_args.args[1])

            har_file = tmp_p / 'trace.har'
            with mock.patch.object(bridge, '_send_browser', return_value={'tabId': 1, 'count': 1, 'log': {'version': '1.2', 'entries': [{'time': 5}]}}):
                har_res = bridge.browser('network_har_export', {'savePath': str(har_file)})
            self.assertNotIn('log', har_res)
            self.assertEqual(json.loads(har_file.read_text())['log']['version'], '1.2')

            before_f = tmp_p / 'before.png'
            diff_f = tmp_p / 'diff.png'
            before_f.write_bytes(b'PNG_BEFORE')
            diff_b64 = base64.b64encode(b'PNG_DIFF').decode()
            with mock.patch.object(bridge, '_send_browser', return_value={'diffPercent': 12.5, 'diffImage': diff_b64, 'mimeType': 'image/png'}) as m_vd:
                vd = bridge.browser('visual_diff', {'action': 'compare', 'beforePath': str(before_f), 'savePath': str(diff_f), 'returnImage': True})
            self.assertIn('beforeBase64', m_vd.call_args.args[1])
            self.assertEqual(diff_f.read_bytes(), b'PNG_DIFF')
            mcp_items = bridge.format_mcp_content('visual_diff', vd)
            self.assertEqual([i['type'] for i in mcp_items], ['image', 'text'])

    def test_about_page_csp_and_83_tools_catalog(self):
        import re
        ext_dir = bridge.BASE / 'extension'
        about_html = (ext_dir / 'about.html').read_text(encoding='utf-8')
        about_css = (ext_dir / 'about.css').read_text(encoding='utf-8')
        about_js = (ext_dir / 'about.js').read_text(encoding='utf-8')
        popup_html = (ext_dir / 'popup.html').read_text(encoding='utf-8')
        self.assertIn('btn-about', popup_html)
        self.assertIn('about.css', about_html)
        self.assertIn('about.js', about_html)
        self.assertGreater(len(about_css), 1000)
        # Strict MV3 CSP: no inline event handlers or inline script bodies
        self.assertIsNone(re.search(r'\bon[a-z]+\s*=', about_html, re.I))
        for m in re.finditer(r'<script\b([^>]*)>(.*?)</script>', about_html, re.I | re.S):
            self.assertIn('src=', m.group(1))
            self.assertEqual(m.group(2).strip(), '')
        catalog_names = set(re.findall(r"name:\s*'([a-z0-9_]+)'", about_js))
        tool_names = {t[0] for t in bridge.TOOLS}
        self.assertEqual(catalog_names, tool_names)


if __name__ == '__main__':
    unittest.main()
