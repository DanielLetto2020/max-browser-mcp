"""Run against a reloaded Chrome extension and the HTTP fixture on port 8769."""
import importlib.util
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bridge', BASE / 'bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
call = bridge.browser
created = []
download = None
monitored = None
passed = []


def ok(label):
    passed.append(label)
    print('PASS', label, flush=True)


def expect_error(name, args, text):
    try:
        call(name, args)
    except RuntimeError as error:
        assert text in str(error), str(error)
    else:
        raise AssertionError('Expected ' + text)


try:
    assert call('browser_status', {})['version'] == '3.0.0', 'Reload the latest extension first'
    tab = call('tabs_create', {'url': 'http://127.0.0.1:8769/fixture.html'})['id']
    created.append(tab)
    call('wait_page', {'tabId': tab, 'state': 'load'})
    tree_snapshot = call('page_snapshot', {'tabId': tab})
    assert 'tree' in tree_snapshot and 'should-not-leak' not in tree_snapshot['tree']
    snapshot = call('page_snapshot', {'tabId': tab, 'format': 'json'})
    assert not any(el.get('value') == 'should-not-leak' for el in snapshot['elements'])
    found = call('find_elements', {'tabId': tab, 'query': 'Save button'})
    assert found['matches'] and found['matches'][0]['name'] == 'Save'
    target = next(el['ref'] for el in snapshot['elements'] if el.get('name') == 'Name')
    batch_res = call('batch', {'actions': [
        {'name': 'fill', 'arguments': {'tabId': tab, 'ref': target, 'value': 'fixture value'}},
        {'name': 'click', 'arguments': {'tabId': tab, 'role': 'button', 'name': 'Save',
                                        'expect': {'selector': '#result', 'textIncludes': 'Saved: fixture value'}}},
    ]})
    assert batch_res['completed'] == 2 and not batch_res['hadError']
    ok('tree/json snapshot refs, password redaction, natural find, batch fill+click')
    expect_error('click', {'tabId': tab, 'role': 'button', 'name': 'Duplicate'}, 'Ambiguous')
    expect_error('click', {'tabId': tab, 'selector': '#disabled'}, 'disabled')
    ok('ambiguous and disabled target errors')
    call('fill', {'tabId': tab, 'selector': '#shadow-name', 'value': 'shadow'})
    call('click', {'tabId': tab, 'name': 'Shadow save', 'role': 'button',
                   'expect': {'selector': '#shadow-name', 'value': 'shadow clicked'}})
    call('select_option', {'tabId': tab, 'role': 'combobox', 'name': 'Choice', 'value': 'Beta'})
    call('set_checked', {'tabId': tab, 'role': 'checkbox', 'name': 'Enabled', 'checked': True})
    call('fill', {'tabId': tab, 'role': 'textbox', 'name': 'Editor', 'value': 'edited'})
    ok('open Shadow DOM, select by text, checkbox and contenteditable')
    for frame in call('frames_list', {'tabId': tab}):
        if not frame.get('url', '').endswith('/frame.html'):
            continue
        args = {'tabId': tab, 'frameId': frame['frameId']}
        call('fill', {**args, 'role': 'textbox', 'name': 'Frame name', 'value': 'inside frame'})
        call('click', {**args, 'role': 'button', 'name': 'Frame save',
                       'expect': {'frameId': frame['frameId'], 'selector': 'body[data-clicked=yes]'}})
        shot = call('screenshot', {**args, 'selector': '#frame-name', 'format': 'jpeg'})
        assert shot['image']
        ok('iframe click, fill and screenshot: ' + frame['url'])
    call('fill', {'tabId': tab, 'selector': '#name', 'value': ''})
    call('insert_text', {'tabId': tab, 'selector': '#name', 'text': 'typed',
                         'expect': {'selector': '#name', 'value': 'typed'}})
    call('press_key', {'tabId': tab, 'selector': '#name', 'key': 'Backspace',
                       'expect': {'selector': '#name', 'value': 'type'}})
    ok('trusted text and keyboard events')
    call('wait_for', {'tabId': tab, 'selector': '#hidden', 'state': 'hidden'})
    with ThreadPoolExecutor() as pool:
        future = pool.submit(call, 'wait_change', {'tabId': tab, 'selector': '#result', 'equals': 'changed'})
        call('javascript', {'tabId': tab, 'code': "setTimeout(()=>document.querySelector('#result').textContent='changed',300); true"})
        assert future.result()['verified']
    ok('hidden-element and asynchronous change waits')
    call('upload_files', {'tabId': tab, 'selector': '#upload', 'files': [str(BASE / 'test/download.txt')]})
    download = call('download_start', {'url': 'http://127.0.0.1:8769/download.txt', 'filename': 'max-browser-test.txt'})['id']
    result = call('download_wait', {'downloadId': download})
    assert result['state'] == 'complete'
    ok('file selection and completed download')
    call('diagnostics_start', {'tabId': tab})
    monitored = tab
    call('reload', {'tabId': tab, 'waitUntil': 'load'})
    call('wait_page', {'tabId': tab, 'state': 'networkIdle'})
    logs = call('diagnostics_get', {'tabId': tab})
    assert any(event.get('status') == 200 for event in logs['network'])
    assert any('fixture ready' in event.get('text', '') for event in logs['console'])
    expect_error('click', {'tabId': tab, 'ref': target}, 'Stale')
    for options in [{}, {'fullPage': True}, {'selector': '#save'}, {'scale': .5}]:
        shot = call('screenshot', {'tabId': tab, 'format': 'jpeg', 'quality': 55, **options})
        assert shot['image']
    call('diagnostics_stop', {'tabId': tab})
    monitored = None
    ok('network/console diagnostics, load and idle waits, stale refs, screenshots')
    call('control_indicator', {'tabId': tab, 'enabled': False})
    call('get_page_text', {'tabId': tab})
    assert call('javascript', {'tabId': tab, 'code': "!document.getElementById('max-browser-control-indicator')"})
    call('control_indicator', {'tabId': tab, 'enabled': True})
    assert call('javascript', {'tabId': tab, 'code': "!!document.getElementById('max-browser-control-indicator')"})
    ok('indicator enable/disable persists across page reads')
    for _ in range(2):
        created.append(call('tabs_create', {'url': 'about:blank'})['id'])
    pair = created[-2:]
    group = call('tabs_group', {'tabIds': pair, 'title': 'Max test', 'color': 'green'})
    call('group_update', {'groupId': group['id'], 'collapsed': True, 'title': 'Updated test'})
    assert any(g['title'] == 'Updated test' for g in call('groups_list', {}))
    call('tabs_ungroup', {'tabIds': pair})
    call('tabs_reorder', {'tabIds': list(reversed(pair))})
    ordered = [t['id'] for t in call('tabs_list', {})]
    assert ordered.index(pair[1]) < ordered.index(pair[0])
    ok('tab grouping, group updates, ungrouping and reordering')
    print(json.dumps({'passed': passed, 'count': len(passed)}, ensure_ascii=False), flush=True)
finally:
    if monitored is not None:
        try:
            call('diagnostics_stop', {'tabId': monitored})
        except Exception:
            pass
    for tab_id in reversed(created):
        try:
            call('tabs_close', {'tabId': tab_id})
        except Exception:
            pass
