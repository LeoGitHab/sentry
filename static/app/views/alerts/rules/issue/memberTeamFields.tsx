import {Component} from 'react';
import styled from '@emotion/styled';

import SelectControl from 'sentry/components/forms/selectControl';
import TeamSelector from 'sentry/components/forms/teamSelector';
import {PanelItem} from 'sentry/components/panels';
import SelectMembers from 'sentry/components/selectMembers';
import space from 'sentry/styles/space';
import {Organization, Project} from 'sentry/types';
import {
  IssueAlertRuleAction,
  IssueAlertRuleCondition,
  MailActionTargetType,
} from 'sentry/types/alerts';

interface OptionRecord {
  label: string;
  value: string;
}

type Props = {
  disabled: boolean;
  loading: boolean;
  memberValue: string | number;
  onChange: (action: IssueAlertRuleAction) => void;
  options: OptionRecord[];
  organization: Organization;
  project: Project;
  ruleData: IssueAlertRuleAction | IssueAlertRuleCondition;
  teamValue: string | number;
};

class MemberTeamFields extends Component<Props> {
  handleChange = (attribute: 'targetType' | 'targetIdentifier', newValue: string) => {
    const {onChange, ruleData} = this.props;
    if (newValue === ruleData[attribute]) {
      return;
    }
    const newData = {
      ...ruleData,
      [attribute]: newValue,
    };
    /**
     * TargetIdentifiers between the targetTypes are not unique, and may wrongly map to something that has not been
     * selected. E.g. A member and project can both have the `targetIdentifier`, `'2'`. Hence we clear the identifier.
     **/
    if (attribute === 'targetType') {
      newData.targetIdentifier = '';
    }
    onChange(newData);
  };

  handleChangeActorType = (optionRecord: OptionRecord) => {
    this.handleChange('targetType', optionRecord.value);
  };

  handleChangeActorId = (optionRecord: OptionRecord & {[key: string]: any}) => {
    this.handleChange('targetIdentifier', optionRecord.value);
  };

  render(): React.ReactElement {
    const {
      disabled,
      loading,
      project,
      organization,
      ruleData,
      memberValue,
      teamValue,
      options,
    } = this.props;

    const teamSelected = ruleData.targetType === teamValue;
    const memberSelected = ruleData.targetType === memberValue;
    // (gilbert): remove this after experiment
    const releaseMembersSelected =
      ruleData.targetType === MailActionTargetType.ReleaseMembers;

    const selectControlStyles = {
      control: provided => ({
        ...provided,
        minHeight: '28px',
        height: '28px',
      }),
    };

    return (
      <PanelItemGrid>
        <SelectControl
          isClearable={false}
          isDisabled={disabled || loading}
          value={ruleData.targetType}
          styles={selectControlStyles}
          options={options}
          onChange={this.handleChangeActorType}
        />
        {teamSelected ? (
          <TeamSelector
            disabled={disabled}
            key={teamValue}
            project={project}
            // The value from the endpoint is of type `number`, `SelectMembers` require value to be of type `string`
            value={`${ruleData.targetIdentifier}`}
            styles={selectControlStyles}
            onChange={this.handleChangeActorId}
            useId
          />
        ) : memberSelected ? (
          <SelectMembers
            disabled={disabled}
            key={teamSelected ? teamValue : memberValue}
            project={project}
            organization={organization}
            // The value from the endpoint is of type `number`, `SelectMembers` require value to be of type `string`
            value={`${ruleData.targetIdentifier}`}
            styles={selectControlStyles}
            onChange={this.handleChangeActorId}
          />
        ) : releaseMembersSelected ? (
          <TeamSelector
            disabled={disabled}
            key={teamValue}
            project={project}
            // The value from the endpoint is of type `number`, `SelectMembers` require value to be of type `string`
            value={`${ruleData.targetIdentifier}`}
            styles={selectControlStyles}
            onChange={this.handleChangeActorId}
            useId
          />
        ) : null}
      </PanelItemGrid>
    );
  }
}

const PanelItemGrid = styled(PanelItem)`
  display: grid;
  grid-template-columns: 200px 200px;
  padding: 0;
  align-items: center;
  gap: ${space(2)};
`;

export default MemberTeamFields;
