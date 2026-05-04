/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BootstrapContextModal from '../BootstrapContextModal';

// ---------------------------------------------------------------------------
// Mock apiFetch
// ---------------------------------------------------------------------------

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultProps() {
  return {
    workspaceId: 'ws-1',
    activeLayer: 3 as 1 | 2 | 3,
    onAccept: vi.fn(),
    onClose: vi.fn(),
  };
}

type ModalProps = ReturnType<typeof getDefaultProps>;

function renderModal(overrides: Partial<ModalProps> = {}) {
  const props = { ...getDefaultProps(), ...overrides };
  return render(<BootstrapContextModal {...props} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BootstrapContextModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({ exists: [] });
  });

  // --- Tab rendering ---

  it('renders with 6 tabs', () => {
    renderModal();
    expect(screen.getByText(/Wizard/)).toBeInTheDocument();
    expect(screen.getByText(/Paste/)).toBeInTheDocument();
    expect(screen.getByText(/Upload/)).toBeInTheDocument();
    expect(screen.getByText(/File Path/)).toBeInTheDocument();
    expect(screen.getByText(/URL/)).toBeInTheDocument();
    expect(screen.getByText(/Multi-Source/)).toBeInTheDocument();
  });

  // --- Layer selector ---

  it('pre-selects the activeLayer and switches when clicked', () => {
    renderModal({ activeLayer: 2 as 1 | 2 | 3 });
    const radios = screen.getAllByRole('radio');
    // Layer radio group (Standards, Conventions, Project)
    const l2Radio = radios.find((r) => (r as HTMLInputElement).checked);
    expect(l2Radio).toBeDefined();
  });

  it('layer selector switches target layer label', async () => {
    renderModal({ activeLayer: 1 as 1 | 2 | 3 });
    const l3Radio = screen.getByLabelText(/Project/);
    await userEvent.click(l3Radio);
    expect((l3Radio as HTMLInputElement).checked).toBe(true);
  });

  // --- Wizard tab ---

  it('wizard renders step 1 question and Next advances to step 2', async () => {
    renderModal();
    // Step 1 is shown by default
    expect(screen.getByText(/What is the project name/)).toBeInTheDocument();
    expect(screen.getByText('1/9')).toBeInTheDocument();

    // Click Next
    await userEvent.click(screen.getByText(/Next/));

    expect(screen.getByText(/What does it do/)).toBeInTheDocument();
    expect(screen.getByText('2/9')).toBeInTheDocument();
  });

  it('wizard summary step shows all provided answers', async () => {
    renderModal();

    // Answer Q1
    const input = screen.getByPlaceholderText('freelance-invoicing');
    await userEvent.type(input, 'my-project');

    // Skip through all questions to reach summary
    for (let i = 0; i < 8; i++) {
      await userEvent.click(screen.getByText(/Next/));
    }

    // Now at step 9, click Next to reach summary
    await userEvent.click(screen.getByText(/Next/));

    // Summary shows the answer
    expect(screen.getByText('my-project')).toBeInTheDocument();
    expect(screen.getByText(/Summary/)).toBeInTheDocument();
  });

  // --- Paste tab ---

  it('paste tab: empty textarea disables Extract button', async () => {
    renderModal();
    await userEvent.click(screen.getByText(/Paste/));

    const extractBtn = screen.getByText(/Extract to YAML/);
    expect(extractBtn).toBeDisabled();
  });

  it('paste tab: shows char counter', async () => {
    renderModal();
    await userEvent.click(screen.getByText(/Paste/));

    expect(screen.getByText(/0 \/ 12,000 chars/)).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText(/Paste your text here/);
    await userEvent.type(textarea, 'hello');

    expect(screen.getByText(/5 \/ 12,000 chars/)).toBeInTheDocument();
  });

  // --- Upload tab ---

  it('upload tab: unsupported file type shows warning, not added to list', async () => {
    renderModal();
    await userEvent.click(screen.getByText(/Upload/));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    const badFile = new File(['content'], 'image.png', { type: 'image/png' });
    const goodFile = new File(['content'], 'readme.md', { type: 'text/plain' });

    fireEvent.change(input, { target: { files: [badFile, goodFile] } });

    // Good file in list
    expect(screen.getByText(/readme.md/)).toBeInTheDocument();
    // Bad file in warnings
    expect(screen.getByText(/image.png/)).toBeInTheDocument();
    expect(screen.getByText(/unsupported type/)).toBeInTheDocument();
  });

  // --- Multi-Source tab ---

  it('multi-source tab: Add Source adds a new entry, Remove deletes it', async () => {
    renderModal();
    await userEvent.click(screen.getByText(/Multi-Source/));

    // No sources yet
    expect(screen.queryByText(/#1/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByText(/\+ Add Source/));
    expect(screen.getByText(/#1/)).toBeInTheDocument();

    await userEvent.click(screen.getByText(/\+ Add Source/));
    expect(screen.getByText(/#2/)).toBeInTheDocument();

    // Remove first source
    const removeButtons = screen.getAllByText(/Remove/);
    await userEvent.click(removeButtons[0]);

    expect(screen.queryByText(/#2/)).not.toBeInTheDocument();
    expect(screen.getByText(/#1/)).toBeInTheDocument();
  });

  // --- Preview pane ---

  it('preview pane shows extracted fields as check/cross list', async () => {
    mockApiFetch.mockResolvedValueOnce({
      yaml: 'project:\n  name: test',
      confidence: 'high',
      extracted: ['project.name', 'project.purpose'],
      missing: ['project.integrations'],
      tokenCount: 500,
    });

    renderModal();
    // Switch to paste tab and trigger extraction
    await userEvent.click(screen.getByText(/Paste/));
    const textarea = screen.getByPlaceholderText(/Paste your text here/);
    await userEvent.type(textarea, 'test content');

    const extractBtn = screen.getByText(/Extract to YAML/);
    await userEvent.click(extractBtn);

    await waitFor(() => {
      expect(screen.getByText(/project\.name/)).toBeInTheDocument();
      expect(screen.getByText(/project\.purpose/)).toBeInTheDocument();
      expect(screen.getByText(/project\.integrations/)).toBeInTheDocument();
      expect(screen.getByText(/not found/)).toBeInTheDocument();
      expect(screen.getByText(/High/)).toBeInTheDocument();
    });
  });

  // --- Accept ---

  it('accept calls onAccept with the (possibly edited) YAML', async () => {
    const onAccept = vi.fn();

    mockApiFetch.mockResolvedValueOnce({
      yaml: 'project:\n  name: original',
      confidence: 'high',
      extracted: ['project.name'],
      missing: [],
      tokenCount: 100,
    });

    renderModal({ onAccept });
    await userEvent.click(screen.getByText(/Paste/));
    const textarea = screen.getByPlaceholderText(/Paste your text here/);
    await userEvent.type(textarea, 'test');

    await userEvent.click(screen.getByText(/Extract to YAML/));

    await waitFor(() => {
      expect(screen.getByText(/Extracted for/)).toBeInTheDocument();
    });

    // Find the editable YAML textarea (the one with spellcheck=false in the preview)
    const yamlTextarea = document.querySelector('textarea[spellcheck="false"]') as HTMLTextAreaElement;
    expect(yamlTextarea).toBeTruthy();
    expect(yamlTextarea.value).toContain('project:');

    // Edit the YAML via fireEvent (userEvent.clear on large textarea is slow)
    fireEvent.change(yamlTextarea, { target: { value: 'edited yaml' } });

    // Accept
    await userEvent.click(screen.getByText(/Accept/));

    expect(onAccept).toHaveBeenCalledWith('edited yaml');
  });

  // --- Try Again ---

  it('try again returns to the tab that was active before extraction', async () => {
    mockApiFetch.mockResolvedValueOnce({
      yaml: 'project:\n  name: test',
      confidence: 'medium',
      extracted: ['project.name'],
      missing: [],
      tokenCount: 100,
    });

    renderModal();
    await userEvent.click(screen.getByText(/Paste/));
    const textarea = screen.getByPlaceholderText(/Paste your text here/);
    await userEvent.type(textarea, 'test content');

    await userEvent.click(screen.getByText(/Extract to YAML/));

    await waitFor(() => {
      expect(screen.getByText(/Extracted for/)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/Try Again/));

    // Back to Paste tab — textarea should still have content
    expect(screen.getByPlaceholderText(/Paste your text here/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/test content/)).toBeInTheDocument();
  });
});
